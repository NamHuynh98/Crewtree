// SPDX-License-Identifier: Apache-2.0

export interface ConcurrencyLimits {
  /** Settings → Limits: one account quota for the whole machine */
  global: number;
  /** Session override, only ever lower than the global limit */
  session: number;
}

interface Waiter {
  agentId: string;
  sessionId: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Slots for agents that are generating output (PLAN.md 4.3). Agents waiting for children, approval or an
 * answer release their slot, so a parent waiting on its children can never deadlock the tree.
 * Waiters are served FIFO, skipping those whose session is at its own limit.
 */
export class ConcurrencyLimiter {
  private holders = new Map<string, string>(); // agentId -> sessionId
  private waiters: Waiter[] = [];

  constructor(private getLimits: (sessionId: string) => ConcurrencyLimits) {}

  public holds(agentId: string): boolean {
    return this.holders.has(agentId);
  }

  public runningCount(sessionId?: string): number {
    if (!sessionId) return this.holders.size;
    let count = 0;
    for (const sid of this.holders.values()) if (sid === sessionId) count++;
    return count;
  }

  public isWaiting(agentId: string): boolean {
    return this.waiters.some((w) => w.agentId === agentId);
  }

  private canGrant(sessionId: string): boolean {
    const limits = this.getLimits(sessionId);
    return this.holders.size < limits.global && this.runningCount(sessionId) < Math.min(limits.session, limits.global);
  }

  /** Resolves once the agent holds a slot (immediately when one is free or already held). */
  public acquire(sessionId: string, agentId: string): Promise<void> {
    if (this.holders.has(agentId)) return Promise.resolve();
    if (!this.waiters.some((w) => w.agentId === agentId) && this.canGrant(sessionId)) {
      this.holders.set(agentId, sessionId);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ agentId, sessionId, resolve, reject });
    });
  }

  public release(agentId: string): void {
    if (this.holders.delete(agentId)) this.drain();
  }

  /** Drops a pending acquire (agent disposed / task cancelled). */
  public cancel(agentId: string, reason = 'Cancelled'): void {
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      if (w.agentId === agentId) w.reject(new Error(reason));
      else remaining.push(w);
    }
    this.waiters = remaining;
    this.release(agentId);
  }

  /** Re-check waiters after limits change (settings saved). */
  public drain(): void {
    for (let i = 0; i < this.waiters.length;) {
      const w = this.waiters[i];
      if (this.canGrant(w.sessionId)) {
        this.waiters.splice(i, 1);
        this.holders.set(w.agentId, w.sessionId);
        w.resolve();
      } else {
        i++;
      }
    }
  }
}
