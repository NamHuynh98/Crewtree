// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { AgentFrontmatterSchema, type ResourceScope } from '@crewtree/shared';
import { writeFileAtomic } from '../../lib/atomicWrite.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { EventBus } from '../../events/EventBus.js';
import { detectEol, readFrontmatter, splitFrontmatter, updateFrontmatter, withEol } from '../frontmatter.js';
import { encodeResourceId } from '../ids.js';
import { Revisions } from '../revisions.js';
import { ResourceScanner } from '../ResourceScanner.js';
import { agentsDir, WritableAgentScope } from '../scan/agents.js';
import type { ResourceItem } from '../types.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const WRITABLE_AGENT_SCOPES: WritableAgentScope[] = ['crewtree', 'user', 'project'];

export interface AgentWriteResult {
  item: ResourceItem;
  path: string;
}

function assertWritableScope(scope: string): asserts scope is WritableAgentScope {
  if (!WRITABLE_AGENT_SCOPES.includes(scope as WritableAgentScope)) {
    throw new Error(`Agents can only be written to the Crewtree, User or Project scope`);
  }
}

/** Validates an agent file and returns its name (PLAN.md 6.2). */
export function validateAgentContent(content: string): string {
  const parts = splitFrontmatter(content);
  if (!parts) throw new Error('The file must start with a --- frontmatter block');
  const raw = readFrontmatter(content);
  const parsed = AgentFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid frontmatter: ${issue.path.join('.') || 'name'} — ${issue.message}`);
  }
  if (!NAME_RE.test(parsed.data.name)) {
    throw new Error('name may only contain letters, digits, "-" and "_", and must start with a letter or digit');
  }
  if (!parts.body.trim()) throw new Error('The system prompt (body after the frontmatter) is empty');
  return parsed.data.name;
}

function changed(kind: 'agent', name: string) {
  ResourceScanner.getInstance().invalidate(kind);
  EventBus.getInstance().emitEvent({
    sessionId: '',
    type: 'resource.changed',
    payload: { kind, name },
    ts: Date.now(),
  });
}

function project(): string {
  return ProjectService.getInstance().currentPath();
}

function itemFor(scope: WritableAgentScope, name: string): ResourceItem {
  const id = encodeResourceId('agent', scope, name);
  const item = ResourceScanner.getInstance().find(id);
  if (!item) throw new Error('Agent was written but could not be read back');
  return item;
}

function writableItem(id: string): ResourceItem & { path: string } {
  const item = ResourceScanner.getInstance().find(id);
  if (!item || item.kind !== 'agent') throw new Error('Agent not found');
  if (item.readOnly || !item.path) throw new Error(`${item.name} is read-only (${item.scope}); duplicate it to edit`);
  return item as ResourceItem & { path: string };
}

/**
 * Agent files (PLAN.md 6.3): atomic writes, the file's own line endings, a revision for every change,
 * never overwriting another agent and never touching plugin/built-in sources.
 */
export const AgentWriter = {
  create(scope: ResourceScope, content: string): AgentWriteResult {
    assertWritableScope(scope);
    const name = validateAgentContent(content);
    const file = path.join(agentsDir(scope, project()), `${name}.md`);
    if (fs.existsSync(file)) throw new Error(`An agent named "${name}" already exists in the ${scope} scope`);
    writeFileAtomic(file, content);
    Revisions.record({ kind: 'agent', scope, path: file, name, action: 'create', content });
    changed('agent', name);
    return { item: itemFor(scope, name), path: file };
  },

  /** Saves new content; a changed `name` renames the file. */
  update(id: string, content: string, action: 'update' | 'rollback' = 'update'): AgentWriteResult {
    const item = writableItem(id);
    const scope = item.scope as WritableAgentScope;
    const name = validateAgentContent(content);
    const before = fs.readFileSync(item.path, 'utf8');
    const target = name === item.name ? item.path : path.join(path.dirname(item.path), `${name}.md`);
    if (target !== item.path && fs.existsSync(target)) {
      throw new Error(`An agent named "${name}" already exists in the ${scope} scope`);
    }
    Revisions.ensureBaseline('agent', scope, item.path, item.name, before);
    const next = withEol(content, detectEol(before));
    writeFileAtomic(target, next);
    if (target !== item.path) fs.rmSync(item.path);
    Revisions.record({ kind: 'agent', scope, path: target, name, action, content: next });
    if (name !== item.name) changed('agent', item.name);
    changed('agent', name);
    return { item: itemFor(scope, name), path: target };
  },

  delete(id: string): void {
    const item = writableItem(id);
    const content = fs.readFileSync(item.path, 'utf8');
    Revisions.ensureBaseline('agent', item.scope, item.path, item.name, content);
    Revisions.record({ kind: 'agent', scope: item.scope, path: item.path, name: item.name, action: 'delete', content });
    fs.rmSync(item.path);
    changed('agent', item.name);
  },

  /** "Duplicate" / "Duplicate as mine": read-only sources go to the User scope by default. */
  duplicate(id: string, opts: { scope?: ResourceScope; name?: string } = {}): AgentWriteResult {
    const source = ResourceScanner.getInstance().find(id);
    if (!source || source.kind !== 'agent') throw new Error('Agent not found');
    if (!source.path) throw new Error(`${source.name} is built-in and has no definition file to copy`);
    const scope = opts.scope ?? (source.readOnly ? 'user' : source.scope);
    assertWritableScope(scope);
    const dir = agentsDir(scope, project());
    let name = opts.name ?? `${source.name}-copy`;
    for (let n = 2; !opts.name && fs.existsSync(path.join(dir, `${name}.md`)); n++) name = `${source.name}-copy-${n}`;
    const content = updateFrontmatter(fs.readFileSync(source.path, 'utf8'), (doc) => doc.set('name', name));
    return AgentWriter.create(scope, content);
  },

  /** "Move to scope…" between Crewtree / User / Project (PLAN.md 6.1). */
  move(id: string, scope: ResourceScope): AgentWriteResult {
    const item = writableItem(id);
    assertWritableScope(scope);
    if (scope === item.scope) return { item, path: item.path };
    const target = path.join(agentsDir(scope, project()), path.basename(item.path));
    if (fs.existsSync(target)) throw new Error(`An agent named "${item.name}" already exists in the ${scope} scope`);
    const content = fs.readFileSync(item.path, 'utf8');
    Revisions.ensureBaseline('agent', item.scope, item.path, item.name, content);
    writeFileAtomic(target, content);
    fs.rmSync(item.path);
    Revisions.record({ kind: 'agent', scope, path: target, name: item.name, action: 'move', content });
    changed('agent', item.name);
    return { item: itemFor(scope, item.name), path: target };
  },

  /** Restores a revision: to its original path when the agent was deleted, else over the current file. */
  rollback(revisionId: string, currentId?: string): AgentWriteResult {
    const revision = Revisions.get(revisionId);
    if (!revision || revision.kind !== 'agent') throw new Error('Revision not found');
    const current = currentId ? ResourceScanner.getInstance().find(currentId) : undefined;
    if (current && current.name === revision.name && current.path && !current.readOnly) {
      return AgentWriter.update(current.id, revision.content, 'rollback');
    }
    assertWritableScope(revision.scope);
    if (fs.existsSync(revision.path))
      throw new Error('A file already exists where this revision lived; open that agent to roll back');
    writeFileAtomic(revision.path, revision.content);
    Revisions.record({ ...revision, action: 'rollback' });
    changed('agent', revision.name);
    return { item: itemFor(revision.scope, revision.name), path: revision.path };
  },

  /** "Bulk change model" on the Agents page; read-only agents are skipped (PLAN.md 7). */
  bulkModel(
    ids: string[],
    model: string
  ): Array<{ id: string; name: string; ok: boolean; path?: string; error?: string }> {
    if (!model.trim()) throw new Error('model is required');
    return ids.map((id) => {
      const item = ResourceScanner.getInstance().find(id);
      try {
        const writable = writableItem(id);
        const content = updateFrontmatter(fs.readFileSync(writable.path, 'utf8'), (doc) =>
          doc.set('model', model.trim())
        );
        const result = AgentWriter.update(id, content);
        return { id, name: writable.name, ok: true, path: result.path };
      } catch (err: any) {
        return { id, name: item?.name ?? id, ok: false, error: err.message };
      }
    });
  },
};
