// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { watch, type FSWatcher } from 'chokidar';
import { getDb } from '../db/index.js';
import { fileTouchesTable } from '../db/schema.js';
import { EventBus } from '../events/EventBus.js';
import { getSnapshotsDir, normalizePath } from '../paths.js';
import { relativeToCwd } from '../approvals/permissionPatterns.js';
import { FileLockManager } from './FileLockManager.js';

export type TouchOp = 'edit' | 'write' | 'bash' | 'unknown';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo', '.next', 'coverage', '.pnpm-store']);
/** Changes this soon after an Edit/Write of the same file came from that tool, not from Bash. */
const TOOL_ECHO_MS = 3_000;
/** Writes flushed shortly after a Bash command returns still belong to it. */
const BASH_GRACE_MS = 1_500;

interface SessionWatch {
  watcher: FSWatcher;
  cwd: string;
}

/**
 * "Files touched" for nodes and the Changes tab (PLAN.md 5.3): Edit/Write are recorded from hooks with a
 * snapshot of the previous content for diffs; other changes in cwd are attributed to the agent running
 * Bash at that moment (`via Bash`), or `unknown`.
 */
export class FileActivity {
  private static instance: FileActivity;
  private watches = new Map<string, SessionWatch>();
  private recentToolEdits = new Map<string, number>(); // abs path -> ts
  private bashRunning = new Map<string, { sessionId: string; taskId?: string; endedAt?: number }>(); // agentId
  private snapshotSeq = 0;

  public static getInstance(): FileActivity {
    if (!FileActivity.instance) FileActivity.instance = new FileActivity();
    return FileActivity.instance;
  }

  /** Copy of the file before an edit, for diffs when the project is not a git checkpointed repo. */
  public snapshotBeforeEdit(sessionId: string, absPath: string): string | undefined {
    this.recentToolEdits.set(normalizePath(absPath), Date.now());
    if (!fs.existsSync(absPath) || fs.statSync(absPath).size > 2 * 1024 * 1024) return undefined;
    const dir = path.join(getSnapshotsDir(), sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const snapshot = path.join(dir, `${Date.now()}-${++this.snapshotSeq}-${path.basename(absPath)}`);
    fs.copyFileSync(absPath, snapshot);
    return snapshot;
  }

  public recordTouch(params: {
    sessionId: string;
    sessionAgentId: string;
    taskId?: string;
    absPath: string;
    cwd: string;
    op: TouchOp;
    snapshotPath?: string;
  }): void {
    const ts = Date.now();
    if (params.op === 'edit' || params.op === 'write') this.recentToolEdits.set(normalizePath(params.absPath), ts);
    const relPath = relativeToCwd(params.absPath, params.cwd);
    getDb()
      .insert(fileTouchesTable)
      .values({
        id: nanoid(),
        sessionId: params.sessionId,
        sessionAgentId: params.sessionAgentId,
        taskId: params.taskId ?? null,
        path: relPath,
        op: params.op,
        snapshotPath: params.snapshotPath ?? null,
        ts,
      })
      .run();
    EventBus.getInstance().emitEvent({
      sessionId: params.sessionId,
      sessionAgentId: params.sessionAgentId || null,
      type: 'file.touched',
      payload: { path: relPath, op: params.op, taskId: params.taskId, via: params.op === 'bash' ? 'Bash' : undefined },
      ts,
    });
  }

  public bashStarted(sessionId: string, sessionAgentId: string, taskId?: string): void {
    this.bashRunning.set(sessionAgentId, { sessionId, taskId });
  }

  public bashEnded(sessionAgentId: string): void {
    const entry = this.bashRunning.get(sessionAgentId);
    if (entry) entry.endedAt = Date.now();
  }

  /** Watches the session cwd for changes not made through Edit/Write. */
  public watchSession(sessionId: string, cwd: string): void {
    if (this.watches.has(sessionId)) return;
    const watcher = watch(cwd, {
      ignoreInitial: true,
      ignored: (p: string) =>
        normalizePath(p)
          .split('/')
          .some((segment) => IGNORED_DIRS.has(segment)),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const onChange = (absPath: string) => this.attribute(sessionId, cwd, absPath);
    watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    watcher.on('error', (err) => console.warn(`[FileActivity] watcher error for ${cwd}:`, err));
    this.watches.set(sessionId, { watcher, cwd });
  }

  public async unwatchSession(sessionId: string): Promise<void> {
    const entry = this.watches.get(sessionId);
    this.watches.delete(sessionId);
    await entry?.watcher.close();
  }

  public async closeAll(): Promise<void> {
    await Promise.all([...this.watches.keys()].map((id) => this.unwatchSession(id)));
  }

  private attribute(sessionId: string, cwd: string, absPath: string): void {
    const now = Date.now();
    const toolTs = this.recentToolEdits.get(normalizePath(absPath));
    if (toolTs && now - toolTs < TOOL_ECHO_MS) return;

    const runners = [...this.bashRunning.entries()].filter(
      ([, b]) => b.sessionId === sessionId && (!b.endedAt || now - b.endedAt < BASH_GRACE_MS)
    );
    for (const [agentId, b] of this.bashRunning) {
      if (b.endedAt && now - b.endedAt >= BASH_GRACE_MS) this.bashRunning.delete(agentId);
    }
    if (runners.length === 0) {
      this.recordTouch({ sessionId, sessionAgentId: '', absPath, cwd, op: 'unknown' });
      return;
    }
    const holder = FileLockManager.getInstance().holderOf(absPath, now);
    for (const [agentId, b] of runners) {
      this.recordTouch({ sessionId, sessionAgentId: agentId, taskId: b.taskId, absPath, cwd, op: 'bash' });
      // Bash bypasses the Edit/Write lease: the change already happened, so report it (PLAN.md 5.2)
      if (holder && holder.sessionAgentId !== agentId && holder.sessionId === sessionId) {
        EventBus.getInstance().emitEvent({
          sessionId,
          sessionAgentId: agentId,
          type: 'file.conflict',
          payload: {
            path: relativeToCwd(absPath, cwd),
            agentId,
            holderAgentId: holder.sessionAgentId,
            holder: holder.agentName,
            holderTask: holder.taskTitle,
            via: 'Bash',
          },
          ts: now,
        });
      }
    }
  }
}
