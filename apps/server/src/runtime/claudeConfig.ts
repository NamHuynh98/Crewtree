// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { SessionSettings } from '@crewtree/shared';
import { getClaudeDir } from '../paths.js';

export type ConfigGroups = SessionSettings['configGroups'];

export interface ClaudeConfigOptions {
  settingSources?: Array<'user' | 'project' | 'local'>;
  settings?: Record<string, unknown>;
  skills?: string[];
  warnings: string[];
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readSettingsFiles(cwd: string): Record<string, any>[] {
  return [
    path.join(getClaudeDir(), 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ]
    .map(readJson)
    .filter((s): s is Record<string, any> => s !== null);
}

function mergeHooks(files: Record<string, any>[]): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {};
  for (const file of files) {
    for (const [event, matchers] of Object.entries(file.hooks ?? {})) {
      if (Array.isArray(matchers)) merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}

/**
 * Maps the 4 Claude Code config groups (PLAN.md 3.6) onto Agent SDK options.
 *
 * `settingSources` cannot load CLAUDE.md / skills / hooks / permissions separately, so:
 * - CLAUDE.md off  → `claudeMdExcludes` for every memory file
 * - Hooks off      → `disableAllHooks`
 * - Skills off     → `skills: []` + every enabled plugin forced to false
 * - Permissions off → only possible by not loading file sources at all; when another
 *   group still needs them the rules stay active and a warning is returned.
 * Turning permissions off never means bypassing permissions: unmatched tools still go to Approval.
 */
export function buildClaudeConfigOptions(groups: ConfigGroups, cwd: string): ClaudeConfigOptions {
  const { claudemd, skillsPlugins, hooks, permissions } = groups;
  if (claudemd && skillsPlugins && hooks && permissions) {
    return { warnings: [] };
  }

  const files = readSettingsFiles(cwd);

  if (!permissions && !claudemd && !skillsPlugins) {
    const result: ClaudeConfigOptions = { settingSources: [], skills: [], warnings: [] };
    if (hooks) {
      const merged = mergeHooks(files);
      if (Object.keys(merged).length > 0) result.settings = { hooks: merged };
    }
    return result;
  }

  const settings: Record<string, unknown> = {};
  const result: ClaudeConfigOptions = { settings, warnings: [] };

  if (!claudemd) {
    settings.claudeMdExcludes = ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**'];
  }
  if (!hooks) {
    settings.disableAllHooks = true;
  }
  if (!skillsPlugins) {
    result.skills = [];
    const enabledPlugins: Record<string, boolean> = {};
    for (const file of files) {
      for (const id of Object.keys(file.enabledPlugins ?? {})) enabledPlugins[id] = false;
    }
    if (Object.keys(enabledPlugins).length > 0) settings.enabledPlugins = enabledPlugins;
  }
  if (!permissions) {
    result.warnings.push(
      'Permission rules from settings.json cannot be disabled while CLAUDE.md or Skills/Plugins are enabled; they stay active.'
    );
  }

  return result;
}
