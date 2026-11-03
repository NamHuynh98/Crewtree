// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { ResourceScope } from '@crewtree/shared';
import { getClaudeDir, getHomeDir } from '../../paths.js';
import { encodeResourceId } from '../ids.js';
import type { ResourceItem } from '../types.js';
import { markdownFiles, readText } from './common.js';

/** `@path` lines of a CLAUDE.md, resolved like Claude Code (relative to the file, `~` = home). */
export function memoryImports(file: string, content: string): string[] {
  const dir = path.dirname(file);
  return content
    .split(/\r?\n/)
    .map((l) => /^\s*@(\S+)\s*$/.exec(l)?.[1])
    .filter((p): p is string => !!p)
    .map((p) => (p.startsWith('~') ? path.join(getHomeDir(), p.slice(1)) : path.resolve(dir, p)));
}

/** Claude Code's auto-memory folder name for a project: the path with every other character as `-`. */
export function autoMemoryDir(projectDir: string): string {
  return path.join(getClaudeDir(), 'projects', projectDir.replace(/[^a-zA-Z0-9-]/g, '-'), 'memory');
}

function memoryItem(file: string, scope: ResourceScope, role: string, importedBy?: string): ResourceItem | undefined {
  const content = readText(file);
  if (content === undefined) return undefined;
  return {
    id: encodeResourceId('memory', scope, file),
    kind: 'memory',
    name: path.basename(file),
    scope,
    path: file,
    description:
      content
        .split(/\r?\n/)
        .find((l) => l.trim() && !l.startsWith('@'))
        ?.replace(/^#+\s*/, '')
        .slice(0, 160) ?? '',
    readOnly: false,
    metadata: { role, importedBy, imports: memoryImports(file, content), size: content.length },
  };
}

/** CLAUDE.md files with their @import tree, local memory and auto memory (PLAN.md 6.1, UI-WIREFRAMES 10). */
export function scanMemory(projectDir: string): ResourceItem[] {
  const items: ResourceItem[] = [];
  const seen = new Set<string>();
  const add = (file: string, scope: ResourceScope, role: string, importedBy?: string, depth = 0) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved) || depth > 5 || !fs.existsSync(resolved)) return;
    seen.add(resolved);
    const item = memoryItem(resolved, scope, role, importedBy);
    if (!item) return;
    items.push(item);
    for (const imported of item.metadata.imports as string[]) add(imported, scope, 'import', resolved, depth + 1);
  };

  add(path.join(getClaudeDir(), 'CLAUDE.md'), 'user', 'user');
  add(path.join(projectDir, 'CLAUDE.md'), 'project', 'project');
  add(path.join(projectDir, '.claude', 'CLAUDE.md'), 'project', 'project');
  add(path.join(projectDir, 'CLAUDE.local.md'), 'local', 'local');
  add(path.join(projectDir, '.claude', 'CLAUDE.local.md'), 'local', 'local');
  for (const { file } of markdownFiles(autoMemoryDir(projectDir))) add(file, 'project', 'auto');
  return items;
}
