// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { ResourceScope } from '@crewtree/shared';
import { getClaudeDir } from '../../paths.js';
import { readFrontmatter } from '../frontmatter.js';
import { encodeResourceId } from '../ids.js';
import type { ResourceItem } from '../types.js';
import { describe, listDir, readText } from './common.js';
import { listInstalledPlugins } from './plugins.js';

function countFiles(dir: string, depth = 0): number {
  if (depth > 4) return 0;
  return listDir(dir).reduce((n, e) => n + (e.isDir ? countFiles(e.full, depth + 1) : 1), 0);
}

function skillItem(
  dir: string,
  scope: ResourceScope,
  opts: { plugin?: string; synced?: boolean } = {}
): ResourceItem | undefined {
  const file = path.join(dir, 'SKILL.md');
  const content = readText(file);
  if (content === undefined) return undefined;
  const fm = readFrontmatter(content);
  const name = typeof fm.name === 'string' ? fm.name : path.basename(dir);
  const key = opts.plugin ? `${opts.plugin}/${name}` : opts.synced ? `synced/${name}` : name;
  let link: string | undefined;
  try {
    link = fs.lstatSync(dir).isSymbolicLink() ? fs.realpathSync(dir) : undefined;
  } catch {
    link = undefined;
  }
  return {
    id: encodeResourceId('skill', scope, key),
    kind: 'skill',
    name,
    scope,
    path: file,
    description: describe(content),
    readOnly: scope === 'plugin' || !!opts.synced,
    plugin: opts.plugin,
    metadata: { dir, files: countFiles(dir), synced: !!opts.synced, linkTarget: link },
  };
}

/** Skills: `<dir>/<name>/SKILL.md` + supporting files (PLAN.md 6.1). */
export function scanSkills(projectDir: string): ResourceItem[] {
  const items: ResourceItem[] = [];
  const userDir = path.join(getClaudeDir(), 'skills');
  for (const entry of listDir(userDir)) {
    if (!entry.isDir) continue;
    if (entry.name === 'synced') {
      // claude.ai-synced skills: synced/<bucket>/<skill>/SKILL.md, read-only
      for (const bucket of listDir(entry.full).filter((b) => b.isDir)) {
        for (const skill of listDir(bucket.full).filter((s) => s.isDir)) {
          const item = skillItem(skill.full, 'user', { synced: true });
          if (item) items.push(item);
        }
      }
      continue;
    }
    const item = skillItem(entry.full, 'user');
    if (item) items.push(item);
  }
  for (const entry of listDir(path.join(projectDir, '.claude', 'skills')).filter((e) => e.isDir)) {
    const item = skillItem(entry.full, 'project');
    if (item) items.push(item);
  }
  for (const plugin of listInstalledPlugins(projectDir).filter((p) => p.enabled)) {
    for (const entry of listDir(path.join(plugin.installPath, 'skills')).filter((e) => e.isDir)) {
      const item = skillItem(entry.full, 'plugin', { plugin: plugin.id });
      if (item) items.push(item);
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
