// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { projectsTable, sessionsTable } from '../db/schema.js';
import { ProjectService } from '../projects/ProjectService.js';
import { getClaudeDir, getUploadsDir } from '../paths.js';

/** Files above this size are described, not returned (PLAN.md 9). */
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A working directory the browser may browse: the current project, a recent project or a session's cwd.
 * Anything else is refused so a request cannot point the file API at an arbitrary folder.
 */
export function resolveWorkspaceRoot(opts: { cwd?: string; sessionId?: string }): string {
  if (opts.sessionId) {
    const row = getDb().select().from(sessionsTable).where(eq(sessionsTable.id, opts.sessionId)).get();
    if (!row) throw new Error('Session not found');
    return realOrResolved(row.cwd);
  }
  const current = ProjectService.getInstance().currentPath();
  if (!opts.cwd) return realOrResolved(current);
  const wanted = realOrResolved(opts.cwd);
  const known = [
    current,
    ...getDb()
      .select({ path: projectsTable.path })
      .from(projectsTable)
      .all()
      .map((r) => r.path),
    ...getDb()
      .select({ cwd: sessionsTable.cwd })
      .from(sessionsTable)
      .all()
      .map((r) => r.cwd),
  ].map(realOrResolved);
  if (!known.includes(wanted)) throw new Error('Working directory is not a known project');
  return wanted;
}

/** Resolves `p` (relative to `root` or absolute) and checks it stays inside root, ~/.claude or uploads. */
export function resolveReadablePath(root: string, p: string): string {
  const abs = realOrResolved(path.isAbsolute(p) ? p : path.join(root, p));
  const allowed = [root, getClaudeDir(), getUploadsDir()].map(realOrResolved);
  if (!allowed.some((dir) => isInside(abs, dir))) throw new Error('Path is outside the allowed folders');
  return abs;
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface FileView {
  path: string;
  absPath: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content?: string;
}

export function readFileView(root: string, p: string): FileView {
  const absPath = resolveReadablePath(root, p);
  const stat = fs.statSync(absPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new Error('File not found');
  const rel = isInside(absPath, root) ? path.relative(root, absPath).replace(/\\/g, '/') : absPath;
  const base = { path: rel, absPath, size: stat.size, binary: false, tooLarge: stat.size > MAX_VIEW_BYTES };
  if (base.tooLarge) return base;
  const buf = fs.readFileSync(absPath);
  if (isBinary(buf)) return { ...base, binary: true };
  return { ...base, content: buf.toString('utf8') };
}
