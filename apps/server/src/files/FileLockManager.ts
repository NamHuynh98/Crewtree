// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import { normalizePath } from '../paths.js';

export interface LeaseOwner {
  sessionId: string;
  sessionAgentId: string;
  agentName: string;
  taskId?: string;
  taskTitle?: string;
}

interface Lease extends LeaseOwner {
  path: string;
  expiresAt: number;
}

export type LockResult = { ok: true } | { ok: false; holder: LeaseOwner };

const LEASE_MS = 30 * 60_000;

/**
 * Edit/Write leases (PLAN.md 5.2): an agent working on a task keeps the files it edits until the task ends.
 * Another agent editing the same file is refused. Paths are compared normalized and, on the
 * case-insensitive default filesystems of macOS/Windows, lowercased.
 */
export class FileLockManager {
  private static instance: FileLockManager;
  private leases = new Map<string, Lease>();

  public static getInstance(): FileLockManager {
    if (!FileLockManager.instance) FileLockManager.instance = new FileLockManager();
    return FileLockManager.instance;
  }

  public static key(absPath: string): string {
    const normalized = normalizePath(path.resolve(absPath));
    return process.platform === 'linux' ? normalized : normalized.toLowerCase();
  }

  public acquire(absPath: string, owner: LeaseOwner, now = Date.now()): LockResult {
    const key = FileLockManager.key(absPath);
    const lease = this.leases.get(key);
    if (lease && lease.expiresAt > now && lease.sessionAgentId !== owner.sessionAgentId) {
      return { ok: false, holder: lease };
    }
    this.leases.set(key, { ...owner, path: normalizePath(path.resolve(absPath)), expiresAt: now + LEASE_MS });
    return { ok: true };
  }

  public holderOf(absPath: string, now = Date.now()): LeaseOwner | undefined {
    const lease = this.leases.get(FileLockManager.key(absPath));
    return lease && lease.expiresAt > now ? lease : undefined;
  }

  /** Task ended / cancelled */
  public releaseTask(taskId: string): void {
    for (const [key, lease] of this.leases) if (lease.taskId === taskId) this.leases.delete(key);
  }

  /** Agent disposed or finished work without a task */
  public releaseAgent(sessionAgentId: string): void {
    for (const [key, lease] of this.leases) if (lease.sessionAgentId === sessionAgentId) this.leases.delete(key);
  }

  public leasesOf(sessionAgentId: string): string[] {
    return [...this.leases.values()].filter((l) => l.sessionAgentId === sessionAgentId).map((l) => l.path);
  }
}
