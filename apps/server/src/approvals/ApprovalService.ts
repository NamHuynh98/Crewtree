// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import type { Approval, ApprovalDecision } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { approvalsTable } from '../db/schema.js';
import { EventBus } from '../events/EventBus.js';
import { matchesRule, suggestRule, validateRule } from './permissionPatterns.js';

export interface ApprovalRequest {
  sessionId: string;
  sessionAgentId: string;
  tool: string;
  input: any;
  cwd: string;
  taskId?: string;
  /** e.g. `outside_scope` when an edit leaves the task scope */
  label?: string;
  signal?: AbortSignal;
  /** Called only when the user has to decide (not when a rule already allows the call) */
  onPending?: () => void;
}

export interface ApprovalOutcome {
  allow: boolean;
  reason?: string;
}

function rowToApproval(r: typeof approvalsTable.$inferSelect): Approval {
  return {
    id: r.id,
    sessionId: r.sessionId,
    sessionAgentId: r.sessionAgentId,
    tool: r.tool,
    input: JSON.parse(r.input),
    status: r.status as Approval['status'],
    rule: (r.rule ?? undefined) as Approval['rule'],
    pattern: r.pattern ?? undefined,
    reason: r.reason ?? undefined,
    label: r.label ?? undefined,
    suggestedPattern: r.suggestedPattern ?? undefined,
    taskId: r.taskId ?? undefined,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt ?? undefined,
  };
}

/**
 * Tool permission requests decided by the user on the UI, at every level of the tree (PLAN.md 10).
 * "Always allow" stores a tool + pattern rule for that agent in that session; parents never decide for children.
 * The agent waits without a timeout and without auto-deny; other branches keep running.
 */
export class ApprovalService {
  private static instance: ApprovalService;
  private waiting = new Map<string, (outcome: ApprovalOutcome) => void>();
  private eventBus = EventBus.getInstance();

  public static getInstance(): ApprovalService {
    if (!ApprovalService.instance) ApprovalService.instance = new ApprovalService();
    return ApprovalService.instance;
  }

  /** "Always allow" rules of an agent in its session. */
  public rulesFor(sessionAgentId: string): string[] {
    return getDb()
      .select()
      .from(approvalsTable)
      .where(
        and(
          eq(approvalsTable.sessionAgentId, sessionAgentId),
          eq(approvalsTable.rule, 'pattern'),
          eq(approvalsTable.status, 'allowed')
        )
      )
      .all()
      .flatMap((r) => (r.pattern ? [r.pattern] : []));
  }

  public isAllowedByRule(sessionAgentId: string, tool: string, input: any, cwd: string): boolean {
    return this.rulesFor(sessionAgentId).some((rule) => matchesRule(rule, tool, input, cwd));
  }

  public async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    if (this.isAllowedByRule(req.sessionAgentId, req.tool, req.input, req.cwd)) return { allow: true };

    const id = nanoid();
    const now = Date.now();
    const suggestedPattern = suggestRule(req.tool, req.input, req.cwd);
    getDb()
      .insert(approvalsTable)
      .values({
        id,
        sessionId: req.sessionId,
        sessionAgentId: req.sessionAgentId,
        tool: req.tool,
        input: JSON.stringify(req.input ?? {}),
        status: 'pending',
        label: req.label ?? null,
        suggestedPattern,
        taskId: req.taskId ?? null,
        createdAt: now,
      })
      .run();

    const approval = this.get(id)!;
    const outcome = new Promise<ApprovalOutcome>((resolve) => this.waiting.set(id, resolve));
    req.onPending?.();
    this.eventBus.emitEvent({
      sessionId: req.sessionId,
      sessionAgentId: req.sessionAgentId,
      type: 'agent.permission.request',
      payload: { approvalId: id, tool: req.tool, label: req.label },
      ts: now,
    });
    this.eventBus.emitEvent({
      sessionId: req.sessionId,
      sessionAgentId: req.sessionAgentId,
      type: 'approval.created',
      payload: approval,
      ts: now,
    });

    const onAbort = () => this.settle(id, { decision: 'deny', rule: 'once', reason: 'Request cancelled' });
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await outcome;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  public get(id: string): Approval | undefined {
    const row = getDb().select().from(approvalsTable).where(eq(approvalsTable.id, id)).get();
    return row ? rowToApproval(row) : undefined;
  }

  public list(status?: Approval['status']): Approval[] {
    const q = getDb().select().from(approvalsTable);
    return (status ? q.where(eq(approvalsTable.status, status)).all() : q.all()).map(rowToApproval);
  }

  /** User decision from the Approval Inbox or the node. Throws when the request is unknown or already decided. */
  public decide(id: string, decision: ApprovalDecision): Approval {
    const approval = this.get(id);
    if (!approval) throw new Error('Approval not found');
    if (approval.status !== 'pending') throw new Error('Approval already decided');
    if (decision.decision === 'allow' && decision.rule === 'pattern') {
      const pattern = decision.pattern ?? approval.suggestedPattern;
      const error = pattern ? validateRule(pattern) : 'A pattern is required';
      if (error) throw new Error(error);
      decision = { ...decision, pattern };
    }
    return this.settle(id, decision)!;
  }

  private settle(id: string, decision: ApprovalDecision): Approval | undefined {
    const approval = this.get(id);
    if (!approval || approval.status !== 'pending') return approval;
    const allowed = decision.decision === 'allow';
    getDb()
      .update(approvalsTable)
      .set({
        status: allowed ? 'allowed' : 'denied',
        rule: decision.rule,
        pattern: allowed && decision.rule === 'pattern' ? (decision.pattern ?? null) : null,
        reason: decision.reason ?? null,
        decidedAt: Date.now(),
      })
      .where(eq(approvalsTable.id, id))
      .run();
    const updated = this.get(id)!;
    this.eventBus.emitEvent({
      sessionId: updated.sessionId,
      sessionAgentId: updated.sessionAgentId,
      type: 'approval.resolved',
      payload: updated,
      ts: Date.now(),
    });
    const resolve = this.waiting.get(id);
    this.waiting.delete(id);
    resolve?.(allowed ? { allow: true } : { allow: false, reason: decision.reason || 'Denied by the user' });
    return updated;
  }

  /** Deny everything an agent is still waiting on (agent removed, task cancelled, session stopped). */
  public cancelForAgent(sessionAgentId: string, reason = 'Cancelled'): void {
    for (const approval of this.list('pending')) {
      if (approval.sessionAgentId === sessionAgentId)
        this.settle(approval.id, { decision: 'deny', rule: 'once', reason });
    }
  }

  /** Nobody waits on requests created before a restart. */
  public expireStale(): void {
    for (const approval of this.list('pending')) {
      if (!this.waiting.has(approval.id)) {
        this.settle(approval.id, { decision: 'deny', rule: 'once', reason: 'Server restarted' });
      }
    }
  }
}
