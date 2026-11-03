// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { ClaudeCli } from '../../claude/claudeCli.js';
import { writeFileAtomic } from '../../lib/atomicWrite.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { readSettingsFiles } from '../../runtime/claudeConfig.js';
import { Revisions } from '../revisions.js';
import { ResourceScanner } from '../ResourceScanner.js';
import { claudeJsonPath } from '../scan/mcp.js';
import { readJson } from '../scan/common.js';
import { MASK, maskMcpConfig } from '../secrets.js';
import { NAME_RE, notifyChanged } from '../writers/trackedFiles.js';
import { testMcpServer, type McpTestResult } from './mcpTest.js';

export type McpScope = 'user' | 'local' | 'project';
const SCOPES: McpScope[] = ['user', 'local', 'project'];

export interface McpConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

function project(): string {
  return ProjectService.getInstance().currentPath();
}

function projectMcpFile(): string {
  return path.join(project(), '.mcp.json');
}

/** The unmasked config as stored, for keeping secrets the user did not retype. */
export function rawConfig(scope: McpScope, name: string): McpConfig | undefined {
  if (scope === 'project')
    return readJson<{ mcpServers?: Record<string, McpConfig> }>(projectMcpFile())?.mcpServers?.[name];
  const json = readJson<{ mcpServers?: Record<string, McpConfig>; projects?: Record<string, any> }>(claudeJsonPath());
  if (scope === 'user') return json?.mcpServers?.[name];
  const entry = json?.projects?.[project()] ?? json?.projects?.[project().replace(/\\/g, '/')];
  return entry?.mcpServers?.[name];
}

/** Masked values (••••) mean "unchanged": take them from the stored config (PLAN.md 6.3). */
export function unmask(next: McpConfig, previous?: McpConfig): McpConfig {
  const out: McpConfig = { ...next };
  for (const key of ['env', 'headers'] as const) {
    const values = next[key];
    if (!values) continue;
    out[key] = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, v === MASK ? (previous?.[key]?.[k] ?? '') : v])
    );
    if (Object.values(out[key]!).some((v) => v === ''))
      throw new Error(`${key} has a masked value with no stored secret`);
  }
  if (typeof next.url === 'string' && next.url.includes(MASK)) {
    if (!previous?.url) throw new Error('The URL contains a masked token with no stored value');
    out.url = previous.url;
  }
  return out;
}

function clean(config: McpConfig): McpConfig {
  const type = config.type ?? (config.url ? 'http' : 'stdio');
  if (type === 'stdio') {
    if (!config.command?.trim()) throw new Error('A stdio server needs a command');
    const out: McpConfig = { type, command: config.command.trim(), args: (config.args ?? []).filter((a) => a !== '') };
    if (config.env && Object.keys(config.env).length) out.env = config.env;
    return out;
  }
  if (!config.url?.trim()) throw new Error(`A ${type} server needs a URL`);
  const out: McpConfig = { type, url: config.url.trim() };
  if (config.headers && Object.keys(config.headers).length) out.headers = config.headers;
  return out;
}

function record(scope: McpScope, name: string, action: 'create' | 'update' | 'delete', config: McpConfig) {
  // Revisions keep the masked config only: secrets never reach the database
  Revisions.record({
    kind: 'mcp',
    scope,
    path: scope === 'project' ? projectMcpFile() : claudeJsonPath(),
    name: `${scope}/${name}`,
    action,
    content: JSON.stringify(maskMcpConfig(config), null, 2),
  });
}

async function writeProjectFile(mutate: (servers: Record<string, McpConfig>) => void) {
  const file = projectMcpFile();
  const data = readJson<Record<string, any>>(file) ?? {};
  const servers = { ...(data.mcpServers ?? {}) };
  mutate(servers);
  writeFileAtomic(file, `${JSON.stringify({ ...data, mcpServers: servers }, null, 2)}\n`);
}

/** Pending / enabled / disabled for project (.mcp.json) servers, from Claude Code settings. */
export function projectServerApproval(name: string): 'enabled' | 'disabled' | 'pending' {
  const settings = readSettingsFiles(project());
  const claudeJson = readJson<{ projects?: Record<string, any> }>(claudeJsonPath());
  const entry = claudeJson?.projects?.[project()] ?? {};
  const lists = [...settings, entry];
  if (lists.some((s) => Array.isArray(s.disabledMcpjsonServers) && s.disabledMcpjsonServers.includes(name)))
    return 'disabled';
  if (
    lists.some(
      (s) =>
        s.enableAllProjectMcpServers === true ||
        (Array.isArray(s.enabledMcpjsonServers) && s.enabledMcpjsonServers.includes(name))
    )
  )
    return 'enabled';
  return 'pending';
}

/**
 * MCP servers (PLAN.md 6.3, UI-WIREFRAMES 11). User and local scopes live in ~/.claude.json, which Claude
 * Code rewrites constantly, so they go through `claude mcp add-json/remove`; `.mcp.json` is written directly.
 */
export const McpService = {
  async save(input: { scope: string; name: string; config: McpConfig; originalName?: string }) {
    const scope = input.scope as McpScope;
    if (!SCOPES.includes(scope)) throw new Error('MCP servers can be saved to the User, Local or Project scope');
    if (!NAME_RE.test(input.name)) throw new Error('Server names use letters, digits, ".", "-" or "_"');
    const previousName = input.originalName ?? input.name;
    const previous = rawConfig(scope, previousName);
    if (!input.originalName && previous)
      throw new Error(`An MCP server named "${input.name}" already exists in the ${scope} scope`);
    if (input.originalName && input.originalName !== input.name && rawConfig(scope, input.name)) {
      throw new Error(`An MCP server named "${input.name}" already exists in the ${scope} scope`);
    }
    const config = clean(unmask(input.config, previous));

    if (scope === 'project') {
      await writeProjectFile((servers) => {
        if (input.originalName) delete servers[input.originalName];
        servers[input.name] = config;
      });
    } else {
      const cwd = project();
      if (previous) await ClaudeCli.exec(['mcp', 'remove', previousName, '--scope', scope], { cwd });
      await ClaudeCli.exec(['mcp', 'add-json', input.name, JSON.stringify(config), '--scope', scope], { cwd });
    }
    record(scope, input.name, previous ? 'update' : 'create', config);
    notifyChanged('mcp', input.name);
    return { name: input.name, scope };
  },

  async remove(scope: string, name: string) {
    if (!SCOPES.includes(scope as McpScope)) throw new Error('Plugin MCP servers are read-only');
    const previous = rawConfig(scope as McpScope, name);
    if (!previous) throw new Error('MCP server not found');
    if (scope === 'project') await writeProjectFile((servers) => delete servers[name]);
    else await ClaudeCli.exec(['mcp', 'remove', name, '--scope', scope], { cwd: project() });
    record(scope as McpScope, name, 'delete', previous);
    notifyChanged('mcp', name);
  },

  /** Approve or disable a project (.mcp.json) server in `.claude/settings.local.json`. */
  setProjectServerEnabled(name: string, enabled: boolean) {
    const file = path.join(project(), '.claude', 'settings.local.json');
    const data = readJson<Record<string, any>>(file) ?? {};
    const without = (list: unknown) => (Array.isArray(list) ? list.filter((n) => n !== name) : []);
    const next = {
      ...data,
      enabledMcpjsonServers: enabled
        ? [...without(data.enabledMcpjsonServers), name]
        : without(data.enabledMcpjsonServers),
      disabledMcpjsonServers: enabled
        ? without(data.disabledMcpjsonServers)
        : [...without(data.disabledMcpjsonServers), name],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    notifyChanged('mcp', name);
  },

  /** Connection test of a saved server (by id) or of a form not saved yet. */
  async test(input: { id?: string; scope?: string; name?: string; config?: McpConfig }): Promise<McpTestResult> {
    let config: McpConfig | undefined;
    if (input.id) {
      const item = ResourceScanner.getInstance().find(input.id);
      if (!item || item.kind !== 'mcp') throw new Error('MCP server not found');
      config =
        item.scope === 'plugin'
          ? (() => {
              const data = readJson<Record<string, any>>(item.path!);
              return (data?.mcpServers ?? data)?.[item.name];
            })()
          : rawConfig(item.scope as McpScope, item.name);
    } else if (input.config) {
      const previous = input.scope && input.name ? rawConfig(input.scope as McpScope, input.name) : undefined;
      config = unmask(input.config, previous);
    }
    if (!config) throw new Error('MCP server not found');
    return testMcpServer(config, project());
  },
};
