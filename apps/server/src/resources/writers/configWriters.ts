// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { ResourceKind } from '@crewtree/shared';
import { getClaudeDir } from '../../paths.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { readFrontmatter, splitFrontmatter } from '../frontmatter.js';
import { encodeResourceId } from '../ids.js';
import { Revisions, type Revision } from '../revisions.js';
import { ResourceScanner } from '../ResourceScanner.js';
import { autoMemoryDir } from '../scan/memory.js';
import type { ResourceItem } from '../types.js';
import { NAME_RE, deleteTracked, insideRoot, notifyChanged, readIfExists, writeTracked } from './trackedFiles.js';

export type ConfigScope = 'user' | 'project';
const SCOPES: ConfigScope[] = ['user', 'project'];

function project(): string {
  return ProjectService.getInstance().currentPath();
}

function assertScope(scope: string): asserts scope is ConfigScope {
  if (!SCOPES.includes(scope as ConfigScope)) throw new Error('Only the User or Project scope can be written');
}

function writable(kind: ResourceKind, id: string): ResourceItem & { path: string } {
  const item = ResourceScanner.getInstance().find(id);
  if (!item || item.kind !== kind) throw new Error(`${kind} not found`);
  if (item.readOnly || !item.path)
    throw new Error(`${item.name} is read-only (${item.plugin ? `plugin ${item.plugin}` : item.scope})`);
  return item as ResourceItem & { path: string };
}

// ---------------------------------------------------------------- skills

export function skillsRoot(scope: ConfigScope): string {
  return scope === 'user' ? path.join(getClaudeDir(), 'skills') : path.join(project(), '.claude', 'skills');
}

export interface SkillFileEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

/** Files of a skill folder (SKILL.md first), for the file tree of UI-WIREFRAMES 9. */
export function skillFiles(dir: string): SkillFileEntry[] {
  const out: SkillFileEntry[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4 || out.length > 500) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, childRel);
      const isDir =
        e.isDirectory() || (e.isSymbolicLink() && fs.statSync(full, { throwIfNoEntry: false })?.isDirectory());
      if (isDir) {
        out.push({ path: childRel, type: 'dir' });
        walk(childRel, depth + 1);
      } else out.push({ path: childRel, type: 'file', size: fs.statSync(full, { throwIfNoEntry: false })?.size });
    }
  };
  walk('', 0);
  return out.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : 0));
}

function skillDir(item: ResourceItem): string {
  return String(item.metadata.dir);
}

function validateSkill(content: string): string {
  if (!splitFrontmatter(content)) throw new Error('SKILL.md must start with a --- frontmatter block');
  const fm = readFrontmatter(content);
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name || !NAME_RE.test(name)) throw new Error('SKILL.md needs a name of letters, digits, ".", "-" or "_"');
  if (typeof fm.description !== 'string' || !fm.description.trim()) {
    throw new Error('SKILL.md needs a description: it decides when the skill is triggered');
  }
  return name;
}

const skillRevisionName = (skill: string, rel: string) => `${skill}/${rel}`;

export const SkillWriter = {
  /** New skill folder with SKILL.md and optional supporting files (AI Generate, + New). */
  create(scope: string, files: Array<{ path: string; content: string }>): ResourceItem {
    assertScope(scope);
    const main = files.find((f) => f.path === 'SKILL.md');
    if (!main) throw new Error('A skill needs a SKILL.md');
    const name = validateSkill(main.content);
    const dir = path.join(skillsRoot(scope), name);
    if (fs.existsSync(dir)) throw new Error(`A skill named "${name}" already exists in the ${scope} scope`);
    for (const f of files) {
      const abs = insideRoot(dir, f.path);
      writeTracked({ kind: 'skill', scope, name: skillRevisionName(name, f.path), path: abs }, f.content, 'create');
    }
    const item = ResourceScanner.getInstance().find(encodeResourceId('skill', scope, name));
    if (!item) throw new Error('Skill was written but could not be read back');
    return item;
  },

  readFile(id: string, rel: string): { path: string; content?: string; binary: boolean } {
    const item = ResourceScanner.getInstance().find(id);
    if (!item || item.kind !== 'skill') throw new Error('skill not found');
    const abs = insideRoot(skillDir(item), rel);
    const buf = fs.readFileSync(abs);
    const binary = buf.subarray(0, 8000).includes(0);
    return { path: rel, binary, content: binary ? undefined : buf.toString('utf8') };
  },

  writeFile(id: string, rel: string, content: string, action: 'update' | 'rollback' = 'update'): ResourceItem {
    const item = writable('skill', id);
    if (rel === 'SKILL.md') {
      const name = validateSkill(content);
      if (name !== item.name) throw new Error('Renaming a skill is not supported: the folder name is its name');
    }
    const abs = insideRoot(skillDir(item), rel);
    writeTracked(
      { kind: 'skill', scope: item.scope, name: skillRevisionName(item.name, rel), path: abs },
      content,
      action
    );
    return ResourceScanner.getInstance().find(id) ?? item;
  },

  deleteFile(id: string, rel: string): void {
    const item = writable('skill', id);
    if (rel === 'SKILL.md') throw new Error('Delete the skill instead of its SKILL.md');
    const abs = insideRoot(skillDir(item), rel);
    deleteTracked({ kind: 'skill', scope: item.scope, name: skillRevisionName(item.name, rel), path: abs });
  },

  /** Removes the skill; a symlinked skill only loses its link, the target folder is kept. */
  delete(id: string): void {
    const item = writable('skill', id);
    const dir = skillDir(item);
    for (const f of skillFiles(dir).filter((e) => e.type === 'file')) {
      const content = readIfExists(path.join(dir, f.path));
      if (content !== undefined)
        Revisions.record({
          kind: 'skill',
          scope: item.scope,
          path: path.join(dir, f.path),
          name: skillRevisionName(item.name, f.path),
          action: 'delete',
          content,
        });
    }
    if (fs.lstatSync(dir).isSymbolicLink()) fs.unlinkSync(dir);
    else fs.rmSync(dir, { recursive: true, force: true });
    notifyChanged('skill', item.name);
  },

  history(id: string, rel: string): Revision[] {
    const item = ResourceScanner.getInstance().find(id);
    if (!item || item.kind !== 'skill') throw new Error('skill not found');
    return Revisions.list('skill', skillRevisionName(item.name, rel));
  },
};

// ---------------------------------------------------------------- commands

export function commandsRoot(scope: ConfigScope): string {
  return scope === 'user' ? path.join(getClaudeDir(), 'commands') : path.join(project(), '.claude', 'commands');
}

/** `ns/name` → valid segments only */
function commandRel(name: string): string {
  const parts = name.replace(/\.md$/, '').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => !NAME_RE.test(p))) {
    throw new Error('Command names use letters, digits, ".", "-" or "_" (use / for a namespace)');
  }
  return `${parts.join('/')}.md`;
}

function commandKey(item: ResourceItem): string {
  return item.metadata.namespace ? `${item.metadata.namespace}/${item.name}` : item.name;
}

export const CommandWriter = {
  create(scope: string, name: string, content: string): ResourceItem {
    assertScope(scope);
    const rel = commandRel(name);
    const file = insideRoot(commandsRoot(scope), rel);
    if (fs.existsSync(file)) throw new Error(`A command named "${name}" already exists in the ${scope} scope`);
    const key = rel.replace(/\.md$/, '');
    writeTracked({ kind: 'command', scope, name: key, path: file }, content, 'create');
    const item = ResourceScanner.getInstance().find(encodeResourceId('command', scope, key));
    if (!item) throw new Error('Command was written but could not be read back');
    return item;
  },

  update(id: string, content: string, action: 'update' | 'rollback' = 'update'): ResourceItem {
    const item = writable('command', id);
    writeTracked({ kind: 'command', scope: item.scope, name: commandKey(item), path: item.path }, content, action);
    return ResourceScanner.getInstance().find(id) ?? item;
  },

  delete(id: string): void {
    const item = writable('command', id);
    deleteTracked({ kind: 'command', scope: item.scope, name: commandKey(item), path: item.path });
  },

  history(id: string): Revision[] {
    const item = ResourceScanner.getInstance().find(id);
    if (!item || item.kind !== 'command') throw new Error('command not found');
    return Revisions.list('command', commandKey(item));
  },
};

// ---------------------------------------------------------------- memory

export type MemoryTarget = 'user' | 'project' | 'local' | 'auto';

/** Where a new memory file goes (UI-WIREFRAMES 10). `auto` needs a file name. */
export function memoryTargetPath(target: MemoryTarget, fileName?: string): string {
  const proj = project();
  if (target === 'user') return path.join(getClaudeDir(), 'CLAUDE.md');
  if (target === 'project') return path.join(proj, 'CLAUDE.md');
  if (target === 'local') return path.join(proj, 'CLAUDE.local.md');
  if (!fileName || !NAME_RE.test(fileName.replace(/\.md$/, '')))
    throw new Error('Auto memory files need a simple name');
  return path.join(autoMemoryDir(proj), fileName.endsWith('.md') ? fileName : `${fileName}.md`);
}

const memoryScope = (target: MemoryTarget) => (target === 'user' ? 'user' : target === 'local' ? 'local' : 'project');

export const MemoryWriter = {
  create(target: MemoryTarget, content: string, fileName?: string): ResourceItem {
    const file = memoryTargetPath(target, fileName);
    if (fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists`);
    const scope = memoryScope(target);
    writeTracked({ kind: 'memory', scope, name: file, path: file }, content, 'create');
    const item = ResourceScanner.getInstance().find(encodeResourceId('memory', scope, file));
    if (!item) throw new Error('Memory file was written but could not be read back');
    return item;
  },

  /** Only files the scanner lists (CLAUDE.md files, their imports, auto memory) can be written. */
  update(id: string, content: string, action: 'update' | 'rollback' = 'update'): ResourceItem {
    const item = writable('memory', id);
    writeTracked({ kind: 'memory', scope: item.scope, name: item.path, path: item.path }, content, action);
    return ResourceScanner.getInstance().find(id) ?? item;
  },

  delete(id: string): void {
    const item = writable('memory', id);
    deleteTracked({ kind: 'memory', scope: item.scope, name: item.path, path: item.path });
  },

  history(id: string): Revision[] {
    const item = ResourceScanner.getInstance().find(id);
    if (!item || item.kind !== 'memory') throw new Error('memory not found');
    return Revisions.list('memory', item.path!);
  },
};
