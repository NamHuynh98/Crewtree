// SPDX-License-Identifier: Apache-2.0
import os from 'os';
import path from 'path';
import type { ResourceScope } from '@crewtree/shared';
import { getClaudeDir } from '../../paths.js';
import { encodeResourceId } from '../ids.js';
import { maskMcpConfig } from '../secrets.js';
import type { ResourceItem } from '../types.js';
import { readJson } from './common.js';
import { listInstalledPlugins } from './plugins.js';

/** ~/.claude.json (user + local MCP scopes); lives next to ~/.claude unless CLAUDE_CONFIG_DIR moves both. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(getClaudeDir(), '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

function mcpItems(
  servers: Record<string, any> | undefined,
  scope: ResourceScope,
  source: string,
  plugin?: string
): ResourceItem[] {
  return Object.entries(servers ?? {}).map(([name, raw]) => {
    const config = maskMcpConfig(raw ?? {});
    const type = config.type ?? (config.url ? 'http' : 'stdio');
    return {
      id: encodeResourceId('mcp', scope, plugin ? `${plugin}/${name}` : name),
      kind: 'mcp' as const,
      name,
      scope,
      path: source,
      description:
        type === 'stdio'
          ? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
          : String(config.url ?? ''),
      readOnly: scope === 'plugin',
      plugin,
      metadata: { type, config },
    };
  });
}

/** MCP servers: user + local (~/.claude.json), project (.mcp.json), plugins (PLAN.md 6.1). Secrets masked. */
export function scanMcp(projectDir: string): ResourceItem[] {
  const claudeJson = readJson<{ mcpServers?: Record<string, any>; projects?: Record<string, any> }>(claudeJsonPath());
  const projectEntry = claudeJson?.projects?.[projectDir] ?? claudeJson?.projects?.[projectDir.replace(/\\/g, '/')];
  const projectFile = path.join(projectDir, '.mcp.json');
  const items = [
    ...mcpItems(claudeJson?.mcpServers, 'user', claudeJsonPath()),
    ...mcpItems(projectEntry?.mcpServers, 'local', claudeJsonPath()),
    ...mcpItems(readJson<{ mcpServers?: Record<string, any> }>(projectFile)?.mcpServers, 'project', projectFile),
  ];
  for (const plugin of listInstalledPlugins(projectDir).filter((p) => p.enabled)) {
    const file = path.join(plugin.installPath, '.mcp.json');
    const data = readJson<Record<string, any>>(file);
    items.push(...mcpItems(data?.mcpServers ?? data, 'plugin', file, plugin.id));
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
