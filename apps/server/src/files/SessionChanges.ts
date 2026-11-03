// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { fileTouchesTable, sessionAgentsTable } from '../db/schema.js';
import { GitCheckpoint } from './GitCheckpoint.js';
import { MAX_VIEW_BYTES, isBinary, isInside } from './safeFiles.js';

const run = promisify(execFile);

/** Text of `rel` at a git revision, or null when it does not exist there (or the repo has no such revision). */
export async function gitShow(cwd: string, rev: string, rel: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['show', `${rev}:${rel.replace(/\\/g, '/')}`], {
      cwd,
      maxBuffer: MAX_VIEW_BYTES * 2,
      encoding: 'buffer',
    });
    const buf = stdout as unknown as Buffer;
    return isBinary(buf) ? null : buf.toString('utf8');
  } catch {
    return null;
  }
}

function readText(abs: string): string | null {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_VIEW_BYTES) return null;
    const buf = fs.readFileSync(abs);
    return isBinary(buf) ? null : buf.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Added/removed line counts. Lines are matched as a multiset (moved lines count as unchanged), which is
 * cheap on large files and close to `git diff --stat` for typical edits.
 */
export function lineStats(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>();
  // A trailing newline ends the last line; it does not start an empty one
  const lines = (text: string) => (text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : []);
  const a = lines(before);
  const b = lines(after);
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return { added, removed };
}

export interface FileChange {
  path: string;
  /** edit/write through tools, bash = changed while a Bash command of the agent ran */
  ops: string[];
  agents: Array<{ id: string; name: string }>;
  taskIds: string[];
  viaBash: boolean;
  firstTs: number;
  lastTs: number;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
}

interface TouchRow {
  path: string;
  op: string;
  ts: number;
  snapshotPath: string | null;
  taskId: string | null;
  sessionAgentId: string;
  agentName: string | null;
  alias: string | null;
}

function touches(sessionId: string): TouchRow[] {
  return getDb()
    .select({
      path: fileTouchesTable.path,
      op: fileTouchesTable.op,
      ts: fileTouchesTable.ts,
      snapshotPath: fileTouchesTable.snapshotPath,
      taskId: fileTouchesTable.taskId,
      sessionAgentId: fileTouchesTable.sessionAgentId,
      agentName: sessionAgentsTable.agentName,
      alias: sessionAgentsTable.alias,
    })
    .from(fileTouchesTable)
    .leftJoin(sessionAgentsTable, eq(sessionAgentsTable.id, fileTouchesTable.sessionAgentId))
    .where(eq(fileTouchesTable.sessionId, sessionId))
    .orderBy(asc(fileTouchesTable.ts))
    .all();
}

/**
 * Content of a file when the session first touched it: the snapshot taken before the first Edit, else
 * HEAD in a git repo, else empty (created during the session).
 */
async function sessionBase(cwd: string, rows: TouchRow[], isRepo: boolean): Promise<string> {
  const snap = rows.find((r) => r.snapshotPath)?.snapshotPath;
  if (snap) {
    const text = readText(snap);
    if (text !== null) return text;
  }
  if (isRepo) return (await gitShow(cwd, 'HEAD', rows[0].path)) ?? '';
  return '';
}

/** Files changed by the agents of a session (tab Changes, drawer Changes). */
export async function listChanges(sessionId: string, cwd: string, agentId?: string): Promise<FileChange[]> {
  const byPath = new Map<string, TouchRow[]>();
  for (const row of touches(sessionId)) {
    if (!byPath.has(row.path)) byPath.set(row.path, []);
    byPath.get(row.path)!.push(row);
  }
  const isRepo = await GitCheckpoint.isRepo(cwd);
  const out: FileChange[] = [];
  for (const [rel, rows] of byPath) {
    const mine = agentId ? rows.filter((r) => r.sessionAgentId === agentId) : rows;
    if (!mine.length) continue;
    const abs = path.resolve(cwd, rel);
    if (!isInside(abs, cwd)) continue;
    const exists = fs.existsSync(abs);
    const base = await sessionBase(cwd, rows, isRepo);
    const current = exists ? (readText(abs) ?? base) : '';
    const agents = new Map<string, string>();
    for (const r of mine) if (r.sessionAgentId) agents.set(r.sessionAgentId, r.alias || r.agentName || '?');
    out.push({
      path: rel,
      ops: [...new Set(mine.map((r) => r.op))],
      agents: [...agents].map(([id, name]) => ({ id, name })),
      taskIds: [...new Set(mine.map((r) => r.taskId).filter((t): t is string => !!t))],
      viaBash: mine.some((r) => r.op === 'bash'),
      firstTs: mine[0].ts,
      lastTs: mine[mine.length - 1].ts,
      status: !exists ? 'deleted' : base === '' && !rows.some((r) => r.snapshotPath) ? 'added' : 'modified',
      ...lineStats(base, current),
    });
  }
  return out.sort((a, b) => b.lastTs - a.lastTs);
}

export type DiffBase = 'session' | 'head' | `checkpoint:${number}`;

/** Before/after text for the File Viewer diff (PLAN.md 9: HEAD, checkpoint or snapshot before Edit). */
export async function fileDiff(
  sessionId: string | undefined,
  cwd: string,
  rel: string,
  base: DiffBase
): Promise<{ before: string; after: string; base: DiffBase; beforeMissing: boolean }> {
  const abs = path.resolve(cwd, rel);
  const after = readText(abs) ?? '';
  let before: string | null = null;
  if (base === 'head') before = await gitShow(cwd, 'HEAD', rel);
  else if (base.startsWith('checkpoint:') && sessionId) {
    const n = Number(base.slice('checkpoint:'.length));
    const cp = (await GitCheckpoint.list(cwd, sessionId)).find((c) => c.n === n);
    if (!cp) throw new Error('Checkpoint not found');
    before = await gitShow(cwd, cp.commit, rel);
  } else if (sessionId) {
    const rows = touches(sessionId).filter((r) => r.path === rel);
    before = rows.length
      ? await sessionBase(cwd, rows, await GitCheckpoint.isRepo(cwd))
      : await gitShow(cwd, 'HEAD', rel);
  }
  return { before: before ?? '', after, base, beforeMissing: before === null };
}
