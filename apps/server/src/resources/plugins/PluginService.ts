// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { ClaudeCli } from '../../claude/claudeCli.js';
import { getClaudeDir } from '../../paths.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { readJson, listDir, markdownFiles } from '../scan/common.js';
import { listInstalledPlugins } from '../scan/plugins.js';
import { NAME_RE, insideRoot, notifyChanged, writeTracked } from '../writers/trackedFiles.js';

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*(@[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/;

function project(): string {
  return ProjectService.getInstance().currentPath();
}

function assertId(id: string) {
  if (!ID_RE.test(id)) throw new Error('Invalid plugin id');
}

export interface MarketplacePlugin {
  name: string;
  id: string;
  description: string;
  category?: string;
  installed: boolean;
}

export interface Marketplace {
  name: string;
  source: unknown;
  lastUpdated?: string;
  plugins: MarketplacePlugin[];
}

/** Names of a plugin's components for the Details row (UI-WIREFRAMES 12). */
export function pluginDetails(installPath: string) {
  const names = (dir: string) =>
    markdownFiles(path.join(installPath, dir), true).map((f) => f.rel.replace(/\.md$/, ''));
  const mcp = readJson<Record<string, any>>(path.join(installPath, '.mcp.json'));
  const hooks = readJson<{ hooks?: Record<string, unknown> }>(path.join(installPath, 'hooks', 'hooks.json'));
  return {
    agents: names('agents'),
    commands: names('commands'),
    skills: listDir(path.join(installPath, 'skills'))
      .filter((e) => e.isDir && fs.existsSync(path.join(e.full, 'SKILL.md')))
      .map((e) => e.name),
    mcpServers: Object.keys(mcp?.mcpServers ?? mcp ?? {}),
    hooks: Object.keys(hooks?.hooks ?? {}),
  };
}

/**
 * Plugins go through `claude plugin …` (PLAN.md 6.1): install, uninstall, enable/disable, marketplaces.
 * Prompts of the CLI are never auto-accepted: an install that needs confirmation fails with its message.
 */
export const PluginService = {
  details(id: string) {
    const plugin = listInstalledPlugins(project()).find((p) => p.id === id);
    if (!plugin) throw new Error('Plugin not found');
    return { ...plugin, ...pluginDetails(plugin.installPath) };
  },

  async setEnabled(id: string, enabled: boolean) {
    assertId(id);
    await ClaudeCli.exec(['plugin', enabled ? 'enable' : 'disable', id, '--scope', 'user'], { cwd: project() });
    notifyChanged('plugin', id);
  },

  async install(id: string, scope: 'user' | 'project' | 'local' = 'user') {
    assertId(id);
    const out = await ClaudeCli.exec(['plugin', 'install', id, '--scope', scope], {
      cwd: project(),
      timeoutMs: 300_000,
    });
    notifyChanged('plugin', id);
    return out.trim();
  },

  async uninstall(id: string) {
    assertId(id);
    const out = await ClaudeCli.exec(['plugin', 'uninstall', id], { cwd: project() });
    notifyChanged('plugin', id);
    return out.trim();
  },

  marketplaces(): Marketplace[] {
    const known = readJson<Record<string, { source?: unknown; installLocation?: string; lastUpdated?: string }>>(
      path.join(getClaudeDir(), 'plugins', 'known_marketplaces.json')
    );
    const installed = new Set(listInstalledPlugins(project()).map((p) => p.id));
    return Object.entries(known ?? {}).map(([name, m]) => {
      const manifest = m.installLocation
        ? readJson<{ plugins?: Array<{ name: string; description?: string; category?: string }> }>(
            path.join(m.installLocation, '.claude-plugin', 'marketplace.json')
          )
        : undefined;
      return {
        name,
        source: m.source,
        lastUpdated: m.lastUpdated,
        plugins: (manifest?.plugins ?? []).map((p) => ({
          name: p.name,
          id: `${p.name}@${name}`,
          description: p.description ?? '',
          category: p.category,
          installed: installed.has(`${p.name}@${name}`),
        })),
      };
    });
  },

  async addMarketplace(source: string) {
    if (!source.trim() || /[\s;&|`$]/.test(source.trim()))
      throw new Error('Give a GitHub repo (owner/name), URL or path');
    const out = await ClaudeCli.exec(['plugin', 'marketplace', 'add', source.trim()], {
      cwd: project(),
      timeoutMs: 300_000,
    });
    notifyChanged('plugin', source);
    return out.trim();
  },

  /**
   * AI scaffold → files under ~/.claude/skills/<name>/, the folder `claude plugin init` uses; Claude Code
   * loads it as <name>@skills-dir from the next session.
   */
  scaffold(name: string, files: Array<{ path: string; content: string }>) {
    if (!NAME_RE.test(name)) throw new Error('Plugin names use letters, digits, ".", "-" or "_"');
    const dir = path.join(getClaudeDir(), 'skills', name);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
    if (!files.some((f) => f.path === '.claude-plugin/plugin.json'))
      throw new Error('A plugin needs .claude-plugin/plugin.json');
    for (const f of files) {
      const abs = insideRoot(dir, f.path);
      writeTracked({ kind: 'plugin', scope: 'user', name: `${name}/${f.path}`, path: abs }, f.content, 'create');
    }
    return { dir };
  },

  async updateMarketplaces() {
    const out = await ClaudeCli.exec(['plugin', 'marketplace', 'update'], { cwd: project(), timeoutMs: 300_000 });
    notifyChanged('plugin', '*');
    return out.trim();
  },
};
