// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { getClaudeDir } from '../../paths.js';
import { readSettingsFiles } from '../../runtime/claudeConfig.js';
import { encodeResourceId } from '../ids.js';
import type { ResourceItem } from '../types.js';
import { listDir, markdownFiles, readJson } from './common.js';

export interface InstalledPlugin {
  id: string; // name@marketplace
  name: string;
  marketplace?: string;
  version?: string;
  installPath: string;
  installScope: string;
  enabled: boolean;
  description: string;
}

/**
 * Installed plugins (~/.claude/plugins/installed_plugins.json, v1 or v2) and whether settings enable them.
 * Installing/uninstalling goes through `claude plugin …` (Phase 6).
 */
export function listInstalledPlugins(projectDir?: string): InstalledPlugin[] {
  const registry = readJson<{ version?: number; plugins?: Record<string, any> }>(
    path.join(getClaudeDir(), 'plugins', 'installed_plugins.json')
  );
  const enabledMap: Record<string, unknown> = {};
  for (const settings of readSettingsFiles(projectDir ?? process.cwd()))
    Object.assign(enabledMap, settings.enabledPlugins ?? {});

  return Object.entries(registry?.plugins ?? {}).flatMap(([id, entry]) => {
    const install = Array.isArray(entry) ? entry[0] : entry;
    if (!install?.installPath || !fs.existsSync(install.installPath)) return [];
    const manifest = readJson<{ name?: string; description?: string; version?: string }>(
      path.join(install.installPath, '.claude-plugin', 'plugin.json')
    );
    const [name, marketplace] = id.split('@');
    return [
      {
        id,
        name: manifest?.name ?? name,
        marketplace,
        version: install.version ?? manifest?.version,
        installPath: install.installPath,
        installScope: install.scope ?? 'user',
        enabled: enabledMap[id] === true || (Array.isArray(enabledMap[id]) && (enabledMap[id] as unknown[]).length > 0),
        description: manifest?.description ?? '',
      },
    ];
  });
}

export function pluginComponents(installPath: string) {
  const mcp = readJson<{ mcpServers?: Record<string, unknown> }>(path.join(installPath, '.mcp.json'));
  return {
    agents: markdownFiles(path.join(installPath, 'agents')).length,
    skills: listDir(path.join(installPath, 'skills')).filter(
      (e) => e.isDir && fs.existsSync(path.join(e.full, 'SKILL.md'))
    ).length,
    commands: markdownFiles(path.join(installPath, 'commands'), true).length,
    mcpServers: Object.keys(mcp?.mcpServers ?? mcp ?? {}).length,
    hooks: fs.existsSync(path.join(installPath, 'hooks', 'hooks.json')),
  };
}

export function scanPlugins(projectDir?: string): ResourceItem[] {
  return listInstalledPlugins(projectDir).map((p) => ({
    id: encodeResourceId('plugin', 'plugin', p.id),
    kind: 'plugin',
    name: p.id,
    scope: 'plugin',
    path: p.installPath,
    description: p.description,
    readOnly: true,
    plugin: p.id,
    metadata: {
      version: p.version,
      enabled: p.enabled,
      marketplace: p.marketplace,
      installScope: p.installScope,
      components: pluginComponents(p.installPath),
    },
  }));
}
