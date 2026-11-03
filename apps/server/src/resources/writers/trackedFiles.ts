// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { ResourceKind, ResourceScope } from '@crewtree/shared';
import { writeFileAtomic } from '../../lib/atomicWrite.js';
import { EventBus } from '../../events/EventBus.js';
import { detectEol, withEol } from '../frontmatter.js';
import { Revisions, type RevisionAction } from '../revisions.js';
import { ResourceScanner } from '../ResourceScanner.js';

export interface TrackedFile {
  kind: ResourceKind;
  scope: ResourceScope;
  /** Revision key: unique per file of that kind */
  name: string;
  path: string;
}

export function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function notifyChanged(kind: ResourceKind, name: string) {
  ResourceScanner.getInstance().invalidate(kind);
  EventBus.getInstance().emitEvent({
    sessionId: '',
    type: 'resource.changed',
    payload: { kind, name },
    ts: Date.now(),
  });
}

/**
 * Write a Claude Code config file safely (PLAN.md 6.3): baseline of the on-disk content first, atomic
 * write keeping the file's own line endings, then a revision of what was written.
 */
export function writeTracked(file: TrackedFile, content: string, action: RevisionAction = 'update'): void {
  const before = readIfExists(file.path);
  if (before !== undefined) Revisions.ensureBaseline(file.kind, file.scope, file.path, file.name, before);
  const next = before !== undefined ? withEol(content, detectEol(before)) : content;
  writeFileAtomic(file.path, next);
  Revisions.record({ ...file, action: before === undefined && action === 'update' ? 'create' : action, content: next });
  notifyChanged(file.kind, file.name);
}

/** Delete a tracked file; its last content stays restorable from history. */
export function deleteTracked(file: TrackedFile): void {
  const before = readIfExists(file.path);
  if (before === undefined) throw new Error('File not found');
  Revisions.ensureBaseline(file.kind, file.scope, file.path, file.name, before);
  fs.rmSync(file.path, { force: true });
  Revisions.record({ ...file, action: 'delete', content: before });
  notifyChanged(file.kind, file.name);
}

/** `rel` resolved inside `root`, refusing traversal and absolute paths. */
export function insideRoot(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel)) throw new Error('Invalid file path');
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new Error('Path is outside the resource folder');
  return abs;
}

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
