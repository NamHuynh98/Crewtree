// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Session, SessionAgent, SessionStatus, Task, TaskStatus } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { messagesTable, tasksTable } from '../db/schema.js';
import { EventBus } from '../events/EventBus.js';
import { FileLockManager } from '../files/FileLockManager.js';
import { GitCheckpoint } from '../files/GitCheckpoint.js';
import { scopesOverlap } from '../files/scope.js';
import { ApprovalService } from '../approvals/ApprovalService.js';
import type { AgentRuntime, TurnUsage } from './AgentRuntime.js';
import {
  NUDGE_MESSAGE,
  answerMessage,
  childFinishedNotice,
  childQuestionNotice,
  parentMessage,
  taskMessage,
} from './prompts.js';

/** What the TaskManager needs from the session layer. */
export interface TaskHost {
  getSession(sessionId: string): Session | null;
  getAgent(sessionAgentId: string): SessionAgent | undefined;
  getChildren(sessionAgentId: string): SessionAgent[];
  getRuntime(sessionId: string, sessionAgentId: string): Promise<AgentRuntime>;
  peekRuntime(sessionAgentId: string): AgentRuntime | undefined;
  /** Creates a child from the library; enforces canDelegate, `delegates`, maxDepth, maxTotalAgents. */
  spawnChild(parentId: string, agentName: string, alias?: string): Promise<SessionAgent>;
  setSessionStatus(sessionId: string, status: SessionStatus, extra?: Record<string, unknown>): void;
}

type InboxKind = 'user' | 'parent' | 'notice' | 'answer' | 'nudge';

interface InboxItem {
  kind: InboxKind;
  text: string;
  messageId?: string;
  from?: string;
  /** Notices: what they report, so they can be dropped once the parent saw it another way */
  noticeKey?: string;
}

interface Wait {
  taskIds: string[];
  resolve: () => void;
}

export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled', 'interrupted'];
const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running', 'needs_input'];
/** ~2k tokens (PLAN.md 4.2); longer summaries are cut and the agent is told to use `details`. */
export const MAX_SUMMARY_CHARS = 8_000;

const isTerminal = (status: string) => TERMINAL_STATUSES.includes(status as TaskStatus);

export function rowToTask(r: typeof tasksTable.$inferSelect): Task {
  return {
    id: r.id,
    sessionId: r.sessionId,
    fromAgentId: r.fromAgentId,
    toAgentId: r.toAgentId,
    parentTaskId: r.parentTaskId,
    title: r.title,
    instructions: r.instructions,
    scope: JSON.parse(r.scope),
    status: r.status as TaskStatus,
    isRoot: r.isRoot,
    question: r.question,
    answer: r.answer,
    resultSummary: r.resultSummary,
    resultDetails: r.resultDetails,
    completedBy: (r.completedBy ?? null) as Task['completedBy'],
    progress: r.progress,
    files: r.files ? JSON.parse(r.files) : [],
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  };
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || 'Request';
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * Tasks of the N-level tree (PLAN.md 4): root tasks for user messages, delegation to direct children,
 * waiting, questions, cancellation down the branch and summaries flowing up. One task at a time per agent;
 * messages to a busy agent are queued and delivered when its turn ends.
 */
export class TaskManager {
  private inbox = new Map<string, InboxItem[]>();
  private waits = new Map<string, Wait>();
  private nudged = new Set<string>();
  private reported = new Set<string>();
  /** Results/questions the parent already received through wait_for_tasks or get_task_result */
  private seenByParent = new Set<string>();
  private interventions = new Map<string, Array<{ agent: string; message: string }>>();
  private locks = new Map<string, Promise<unknown>>();
  private eventBus = EventBus.getInstance();

  constructor(private host: TaskHost) {}

  // ---------------------------------------------------------------- queries

  public getTask(taskId: string): Task | undefined {
    const row = getDb().select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
    return row ? rowToTask(row) : undefined;
  }

  public listTasks(sessionId: string): Task[] {
    return getDb()
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.sessionId, sessionId))
      .orderBy(asc(tasksTable.createdAt))
      .all()
      .map(rowToTask);
  }

  /** The task an agent is working on (running or waiting for an answer). */
  public currentTask(agentId: string): Task | undefined {
    const row = getDb()
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.toAgentId, agentId), inArray(tasksTable.status, ['running', 'needs_input'])))
      .get();
    return row ? rowToTask(row) : undefined;
  }

  public activeRootTask(sessionId: string): Task | undefined {
    return this.listTasks(sessionId).find((t) => t.isRoot && !isTerminal(t.status));
  }

  public isWaiting(agentId: string): boolean {
    return this.waits.has(agentId);
  }

  private agentName(agentId: string | null | undefined): string {
    if (!agentId) return 'the user';
    const agent = this.host.getAgent(agentId);
    return agent ? agent.alias || agent.agentName : 'unknown agent';
  }

  private hasActiveDescendants(task: Task, all: Task[]): boolean {
    const children = all.filter((t) => t.parentTaskId === task.id);
    return children.some((c) => !isTerminal(c.status) || this.hasActiveDescendants(c, all));
  }

  // ---------------------------------------------------------------- helpers

  /** Serializes work per agent so two deliveries can never start two turns. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  private updateTask(taskId: string, patch: Partial<typeof tasksTable.$inferInsert>): Task {
    getDb().update(tasksTable).set(patch).where(eq(tasksTable.id, taskId)).run();
    const task = this.getTask(taskId)!;
    this.eventBus.emitEvent({
      sessionId: task.sessionId,
      sessionAgentId: task.toAgentId,
      type: 'task.updated',
      payload: task,
      ts: Date.now(),
    });
    return task;
  }

  private pushInbox(agentId: string, item: InboxItem, front = false) {
    const list = this.inbox.get(agentId) ?? [];
    if (front) list.unshift(item);
    else list.push(item);
    this.inbox.set(agentId, list);
  }

  private markDelivered(messageIds: Array<string | undefined>, sessionId: string) {
    for (const id of messageIds) {
      if (!id) continue;
      getDb().update(messagesTable).set({ delivery: 'delivered' }).where(eq(messagesTable.id, id)).run();
      this.eventBus.emitEvent({
        sessionId,
        type: 'message.updated',
        payload: { messageId: id, delivery: 'delivered' },
        ts: Date.now(),
      });
    }
  }

  private send(runtime: AgentRuntime, text: string, opts: { newTask?: boolean } = {}) {
    void runtime.sendMessage(text, opts).catch((err) => {
      console.warn(`[TaskManager] Could not deliver to ${runtime.sessionAgent.agentName}:`, err?.message ?? err);
    });
  }

  // ---------------------------------------------------------------- delivery

  /** Starts the agent's next piece of work when it is between turns. */
  public pump(agentId: string): Promise<void> {
    return this.withLock(agentId, async () => {
      const agent = this.host.getAgent(agentId);
      if (!agent) return;
      const session = this.host.getSession(agent.sessionId);
      if (!session || session.status === 'stopped') return;
      const runtime = await this.host.getRuntime(agent.sessionId, agentId);
      if (runtime.isTurnActive()) return;

      // A queued notice is redundant once wait_for_tasks / get_task_result returned the same thing
      const items = (this.inbox.get(agentId) ?? []).filter((i) => !i.noticeKey || !this.seenByParent.has(i.noticeKey));
      this.inbox.set(agentId, items);
      if (items.length) {
        this.inbox.delete(agentId);
        this.markDelivered(
          items.map((i) => i.messageId),
          agent.sessionId
        );
        this.send(runtime, items.map((i) => i.text).join('\n\n'));
        return;
      }

      const current = this.currentTask(agentId);
      if (current) {
        if (current.status === 'needs_input') runtime.setRestingStatus('needs_input');
        return;
      }
      if (session.status === 'paused') return;

      const next = getDb()
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.toAgentId, agentId), eq(tasksTable.status, 'queued')))
        .orderBy(asc(tasksTable.createdAt))
        .get();
      if (next) await this.startTask(rowToTask(next), session, runtime);
    });
  }

  private async startTask(task: Task, session: Session, runtime: AgentRuntime) {
    const started = this.updateTask(task.id, { status: 'running', startedAt: Date.now() });
    if (task.isRoot) {
      const messageIds = getDb()
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.taskId, task.id))
        .all()
        .map((m) => m.id);
      this.markDelivered(messageIds, session.id);
      if (session.settings.checkpoint && (await GitCheckpoint.isRepo(session.cwd))) {
        try {
          const cp = await GitCheckpoint.create(session.cwd, session.id, task.title);
          this.eventBus.emitEvent({
            sessionId: session.id,
            type: 'session.status',
            payload: { status: session.status, checkpoint: cp },
            ts: Date.now(),
          });
        } catch (err) {
          console.warn('[TaskManager] Git checkpoint failed:', err);
        }
      }
      this.send(runtime, task.instructions, { newTask: true });
      return;
    }
    this.send(
      runtime,
      taskMessage({
        id: started.id,
        title: started.title,
        instructions: started.instructions,
        scope: started.scope,
        files: started.files,
        parentName: this.agentName(started.fromAgentId),
      }),
      { newTask: true }
    );
  }

  // ---------------------------------------------------------------- user input

  /**
   * A user message to an agent (main chat → Supervisor, or a node's own chat). To the Supervisor it
   * starts a root task, answers its pending question, or joins the running request. Busy agents
   * receive it when their turn ends, or right away with `interrupt`.
   */
  public async userMessage(
    sessionId: string,
    agentId: string,
    text: string,
    mode: 'queue' | 'interrupt' = 'queue'
  ): Promise<{ messageId: string; delivery: 'queued' | 'delivered'; taskId?: string }> {
    const session = this.host.getSession(sessionId);
    const agent = this.host.getAgent(agentId);
    if (!session || !agent || agent.sessionId !== sessionId) throw new Error('Agent not found in session');
    if (session.totalTokens >= session.settings.limits.maxTokens) {
      throw new Error(
        `Token budget reached (${session.totalTokens} / ${session.settings.limits.maxTokens}). Raise maxTokens in Session settings to continue.`
      );
    }
    if (session.status === 'completed' || session.status === 'stopped') this.host.setSessionStatus(sessionId, 'active');

    const runtime = await this.host.getRuntime(sessionId, agentId);
    const busy = runtime.isTurnActive();
    const messageId = nanoid();
    const isSupervisor = agentId === session.supervisorAgentId;
    const root = isSupervisor ? this.activeRootTask(sessionId) : undefined;

    let taskId: string | undefined;
    if (isSupervisor && !root) {
      taskId = nanoid();
      getDb()
        .insert(tasksTable)
        .values({
          id: taskId,
          sessionId,
          fromAgentId: null,
          toAgentId: agentId,
          parentTaskId: null,
          title: titleFrom(text),
          instructions: text,
          scope: '[]',
          status: 'queued',
          isRoot: true,
          createdAt: Date.now(),
        })
        .run();
      this.eventBus.emitEvent({
        sessionId,
        sessionAgentId: agentId,
        type: 'task.created',
        payload: this.getTask(taskId)!,
        ts: Date.now(),
      });
    }

    getDb()
      .insert(messagesTable)
      .values({
        id: messageId,
        sessionAgentId: agentId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text }]),
        taskId: taskId ?? root?.id ?? null,
        delivery: 'queued',
        createdAt: Date.now(),
      })
      .run();
    this.eventBus.emitEvent({
      sessionId,
      sessionAgentId: agentId,
      type: 'message.created',
      payload: { messageId, role: 'user', text, delivery: 'queued', taskId: taskId ?? root?.id },
      ts: Date.now(),
    });

    if (root?.status === 'needs_input') {
      this.markDelivered([messageId], sessionId);
      await this.answer(root.id, text, null);
      return { messageId, delivery: 'delivered', taskId: root.id };
    }

    if (!taskId) this.pushInbox(agentId, { kind: 'user', text, messageId });
    if (!isSupervisor && agent.parentId) {
      const list = this.interventions.get(agent.parentId) ?? [];
      list.push({ agent: this.agentName(agentId), message: text });
      this.interventions.set(agent.parentId, list);
      this.checkWait(agent.parentId);
    }

    this.checkWait(agentId);
    if (mode === 'interrupt' && busy && !this.waits.has(agentId)) await runtime.interrupt();
    await this.pump(agentId);
    const delivered = getDb().select().from(messagesTable).where(eq(messagesTable.id, messageId)).get();
    return { messageId, delivery: (delivered?.delivery as 'queued' | 'delivered') ?? 'queued', taskId };
  }

  // ---------------------------------------------------------------- turn lifecycle

  /** Called by the runtime when a turn ends (PLAN.md 4.2 task end rule). */
  public async onTurnEnd(agentId: string, info: TurnUsage): Promise<void> {
    await this.withLock(agentId, async () => {
      const task = this.currentTask(agentId);
      if (!task || task.status !== 'running' || info.isError) return;
      if (task.isRoot) {
        if (!this.hasActiveDescendants(task, this.listTasks(task.sessionId))) {
          this.finish(task, 'done', { summary: info.lastText, completedBy: 'auto' });
        }
        return;
      }
      if (!this.nudged.has(task.id)) {
        this.nudged.add(task.id);
        this.pushInbox(agentId, { kind: 'nudge', text: NUDGE_MESSAGE }, true);
      } else {
        this.finish(task, 'done', { summary: info.lastText || '(no summary)', completedBy: 'auto' });
      }
    });
    await this.pump(agentId);
  }

  /** The agent's process failed: its task fails and the parent is told. */
  public onAgentError(agentId: string, error: string): void {
    const task = this.currentTask(agentId);
    if (task) this.finish(task, 'failed', { summary: `Agent error: ${error}` });
  }

  private finish(
    task: Task,
    status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled'>,
    result: { summary?: string; details?: string; completedBy?: 'tool' | 'auto' }
  ): Task {
    const summary = result.summary ?? '';
    const finished = this.updateTask(task.id, {
      status,
      resultSummary: summary.length > MAX_SUMMARY_CHARS ? summary.slice(0, MAX_SUMMARY_CHARS) + '…' : summary,
      resultDetails: result.details ?? null,
      completedBy: result.completedBy ?? null,
      endedAt: Date.now(),
    });
    this.nudged.delete(task.id);
    FileLockManager.getInstance().releaseTask(task.id);

    if (task.isRoot) {
      const remaining = this.listTasks(task.sessionId).filter((t) => !isTerminal(t.status));
      // A session paused (by the user or the token budget) stays paused
      const session = this.host.getSession(task.sessionId);
      if (remaining.length === 0 && status === 'done' && session?.status === 'active') {
        this.host.setSessionStatus(task.sessionId, 'completed');
      }
    } else {
      this.notifyParent(finished, 'result');
    }
    return finished;
  }

  private notifyParent(task: Task, what: 'result' | 'question') {
    const parentId = task.fromAgentId;
    if (!parentId) return;
    const key = what === 'result' ? `${task.id}:result` : `${task.id}:q:${task.question}`;
    if (this.waits.has(parentId)) {
      this.checkWait(parentId);
      return;
    }
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const name = this.agentName(task.toAgentId);
    this.pushInbox(parentId, {
      kind: 'notice',
      noticeKey: key,
      text:
        what === 'result'
          ? childFinishedNotice(name, task.id, task.status, task.resultSummary ?? '')
          : childQuestionNotice(name, task.id, task.question ?? ''),
    });
    void this.pump(parentId);
  }

  // ---------------------------------------------------------------- tools for every agent

  public completeTask(agentId: string, args: { summary: string; details?: string; files?: string[] }): string {
    const task = this.currentTask(agentId);
    if (!task) throw new Error('You have no active task. Reply normally instead.');
    const details = [args.details, args.files?.length ? `Files: ${args.files.join(', ')}` : undefined]
      .filter(Boolean)
      .join('\n\n');
    this.finish(task, 'done', { summary: args.summary, details: details || undefined, completedBy: 'tool' });
    const warning =
      args.summary.length > MAX_SUMMARY_CHARS
        ? ` Warning: the summary was cut to ${MAX_SUMMARY_CHARS} characters; put long content in \`details\`.`
        : '';
    return `Task ${task.id} completed.${warning} End your turn now.`;
  }

  public askParent(agentId: string, args: { question: string }): string {
    const task = this.currentTask(agentId);
    if (!task) throw new Error('You have no active task. Ask in your reply instead.');
    const updated = this.updateTask(task.id, { status: 'needs_input', question: args.question, answer: null });
    this.eventBus.emitEvent({
      sessionId: task.sessionId,
      sessionAgentId: agentId,
      type: 'task.question',
      payload: { taskId: task.id, question: args.question, isRoot: task.isRoot, from: this.agentName(agentId) },
      ts: Date.now(),
    });
    if (task.isRoot) {
      const session = this.host.getSession(task.sessionId);
      if (session) this.host.setSessionStatus(task.sessionId, session.status, { needsInput: true, taskId: task.id });
    } else {
      this.notifyParent(updated, 'question');
    }
    return `Question sent to ${this.agentName(task.fromAgentId)}. End your turn now; the answer will arrive as your next message.`;
  }

  public reportProgress(agentId: string, args: { text: string }): string {
    const task = this.currentTask(agentId);
    if (task) this.updateTask(task.id, { progress: args.text });
    return 'Progress reported.';
  }

  /** Answer to an ask_parent question, from the parent agent or (root task) the user. */
  public async answer(taskId: string, answer: string, byAgentId: string | null): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    if (task.fromAgentId !== byAgentId) throw new Error(`Task ${taskId} is not yours to answer`);
    if (task.status !== 'needs_input') throw new Error(`Task ${taskId} has no pending question`);
    const updated = this.updateTask(taskId, { status: 'running', answer });
    if (task.isRoot) {
      const session = this.host.getSession(task.sessionId);
      if (session) this.host.setSessionStatus(task.sessionId, session.status, { needsInput: false });
    }
    this.pushInbox(task.toAgentId, { kind: 'answer', text: answerMessage(this.agentName(byAgentId), answer) });
    await this.pump(task.toAgentId);
    return updated;
  }

  // ---------------------------------------------------------------- tools for delegating nodes

  private resolveChild(parentId: string, ref: string): SessionAgent {
    const children = this.host.getChildren(parentId);
    const child =
      children.find((c) => c.id === ref) ??
      children.find((c) => c.alias === ref) ??
      children.find((c) => c.agentName === ref);
    if (!child) {
      const names = children.map((c) => `${c.alias || c.agentName} (${c.id})`).join(', ') || 'none';
      throw new Error(`"${ref}" is not one of your direct children. Your children: ${names}`);
    }
    return child;
  }

  public listAgents(parentId: string) {
    return this.host.getChildren(parentId).map((child) => {
      const runtime = this.host.peekRuntime(child.id);
      const current = this.currentTask(child.id);
      return {
        agentId: child.id,
        name: child.alias || child.agentName,
        agent: child.agentName,
        description: runtime?.description ?? '',
        status: runtime?.getStatus() ?? child.status,
        canDelegate: runtime?.canDelegate ?? false,
        currentTask: current ? { taskId: current.id, title: current.title, status: current.status } : null,
      };
    });
  }

  public async spawnAgent(parentId: string, args: { agentName: string; alias?: string }) {
    const child = await this.host.spawnChild(parentId, args.agentName, args.alias);
    return { agentId: child.id, name: child.alias || child.agentName, depth: child.depth };
  }

  public async delegateTask(
    parentId: string,
    args: { agentId: string; title: string; instructions: string; scope?: string[]; files?: string[] }
  ) {
    const parent = this.host.getAgent(parentId);
    if (!parent) throw new Error('Unknown agent');
    const session = this.host.getSession(parent.sessionId);
    if (!session || session.status === 'stopped') throw new Error('The session is stopped');
    const child = this.resolveChild(parentId, args.agentId);
    const scope = (args.scope ?? []).map((s) => s.trim()).filter(Boolean);

    const parentTask = this.currentTask(parentId);
    if (scope.length) {
      // A subtask naturally lies inside its ancestors' scopes: only other branches can conflict
      const all = this.listTasks(parent.sessionId);
      const ancestors = new Set<string>();
      for (let t = parentTask; t; t = t.parentTaskId ? all.find((x) => x.id === t!.parentTaskId) : undefined) {
        ancestors.add(t.id);
      }
      const conflict = all.find(
        (t) => !isTerminal(t.status) && !ancestors.has(t.id) && t.scope.length && scopesOverlap(scope, t.scope)
      );
      if (conflict) {
        throw new Error(
          `Scope overlaps running task ${conflict.id} "${conflict.title}" of ${this.agentName(conflict.toAgentId)} ` +
            `(scope: ${conflict.scope.join(', ')}). Choose a disjoint scope or wait for that task.`
        );
      }
    }

    const id = nanoid();
    getDb()
      .insert(tasksTable)
      .values({
        id,
        sessionId: parent.sessionId,
        fromAgentId: parentId,
        toAgentId: child.id,
        parentTaskId: parentTask?.id ?? null,
        title: args.title,
        instructions: args.instructions,
        scope: JSON.stringify(scope),
        files: JSON.stringify(args.files ?? []),
        status: 'queued',
        isRoot: false,
        createdAt: Date.now(),
      })
      .run();
    const task = this.getTask(id)!;
    this.eventBus.emitEvent({
      sessionId: parent.sessionId,
      sessionAgentId: child.id,
      type: 'task.created',
      payload: task,
      ts: Date.now(),
    });
    void this.pump(child.id);
    return { taskId: id, agentId: child.id, agent: child.alias || child.agentName, status: task.status };
  }

  private ownedTask(callerId: string, taskId: string): Task {
    const task = this.getTask(taskId);
    if (!task || task.fromAgentId !== callerId) throw new Error(`Task ${taskId} was not delegated by you`);
    return task;
  }

  public getTaskStatus(callerId: string, args: { taskId: string }) {
    const task = this.ownedTask(callerId, args.taskId);
    const runtime = this.host.peekRuntime(task.toAgentId);
    return {
      taskId: task.id,
      title: task.title,
      agent: this.agentName(task.toAgentId),
      status: task.status,
      agentStatus: runtime?.getStatus(),
      progress: task.progress,
      question: task.status === 'needs_input' ? task.question : undefined,
    };
  }

  public getTaskResult(callerId: string, args: { taskId: string }) {
    const task = this.ownedTask(callerId, args.taskId);
    if (!isTerminal(task.status)) throw new Error(`Task ${task.id} is still ${task.status}`);
    this.reported.add(`${task.id}:result`);
    this.seenByParent.add(`${task.id}:result`);
    return {
      taskId: task.id,
      title: task.title,
      agent: this.agentName(task.toAgentId),
      status: task.status,
      summary: task.resultSummary,
      details: task.resultDetails,
      completedBy: task.completedBy,
    };
  }

  public async answerChild(parentId: string, args: { taskId: string; answer: string }): Promise<string> {
    this.ownedTask(parentId, args.taskId);
    await this.answer(args.taskId, args.answer, parentId);
    return `Answer delivered to ${this.agentName(this.getTask(args.taskId)!.toAgentId)}.`;
  }

  public async messageAgent(parentId: string, args: { agentId: string; message: string }): Promise<string> {
    const child = this.resolveChild(parentId, args.agentId);
    const runtime = this.host.peekRuntime(child.id);
    const busy = runtime?.isTurnActive() ?? false;
    this.pushInbox(child.id, { kind: 'parent', text: parentMessage(this.agentName(parentId), args.message) });
    this.checkWait(child.id);
    await this.pump(child.id);
    return busy ? `Queued for ${child.alias || child.agentName}; delivered when its turn ends.` : 'Message delivered.';
  }

  public cancelTask(parentId: string, args: { taskId: string; reason: string }): string {
    const task = this.ownedTask(parentId, args.taskId);
    const cancelled = this.cancelTree(task, args.reason);
    return `Cancelled ${cancelled} task(s).`;
  }

  /** Cancels a task and every task below it (PLAN.md 4.2). Returns how many tasks were cancelled. */
  public cancelTree(task: Task, reason: string): number {
    let count = 0;
    if (!isTerminal(task.status)) {
      const wasCurrent = task.status === 'running' || task.status === 'needs_input';
      this.finish(task, 'cancelled', { summary: `Cancelled: ${reason}` });
      count++;
      if (wasCurrent) {
        ApprovalService.getInstance().cancelForAgent(task.toAgentId, 'Task cancelled');
        this.waits.get(task.toAgentId)?.resolve();
        void this.host.peekRuntime(task.toAgentId)?.interrupt();
      }
    }
    for (const child of this.listTasks(task.sessionId).filter((t) => t.parentTaskId === task.id)) {
      count += this.cancelTree(child, reason);
    }
    return count;
  }

  // ---------------------------------------------------------------- wait_for_tasks

  private waitReady(agentId: string, taskIds: string[]): boolean {
    const tasks = taskIds.map((id) => this.getTask(id)).filter((t): t is Task => !!t);
    if (tasks.every((t) => isTerminal(t.status))) return true;
    if (tasks.some((t) => t.status === 'needs_input' && !this.reported.has(`${t.id}:q:${t.question}`))) return true;
    if ((this.inbox.get(agentId) ?? []).some((i) => i.kind === 'user' || i.kind === 'parent')) return true;
    return (this.interventions.get(agentId)?.length ?? 0) > 0;
  }

  private checkWait(agentId: string) {
    const wait = this.waits.get(agentId);
    if (wait && this.waitReady(agentId, wait.taskIds)) wait.resolve();
  }

  public async waitForTasks(agentId: string, args: { taskIds: string[]; timeoutSec: number }) {
    const taskIds = [...new Set(args.taskIds)];
    if (!taskIds.length) throw new Error('taskIds is empty');
    for (const id of taskIds) this.ownedTask(agentId, id);
    const timeoutSec = Math.min(Math.max(args.timeoutSec, 1), 600);

    let timedOut = false;
    if (!this.waitReady(agentId, taskIds)) {
      const runtime = this.host.peekRuntime(agentId);
      const pending = taskIds.filter((id) => !isTerminal(this.getTask(id)!.status)).length;
      runtime?.enterWaitingChildren(pending);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          this.waits.delete(agentId);
          resolve();
        }, timeoutSec * 1000);
        this.waits.set(agentId, {
          taskIds,
          resolve: () => {
            clearTimeout(timer);
            this.waits.delete(agentId);
            resolve();
          },
        });
      });
      await runtime?.leaveWaitingChildren();
    }
    return this.buildWaitResult(agentId, taskIds, timedOut);
  }

  private buildWaitResult(agentId: string, taskIds: string[], timedOut: boolean) {
    const tasks = taskIds.map((id) => this.getTask(id)!);
    const completed = tasks
      .filter((t) => isTerminal(t.status))
      .map((t) => {
        this.reported.add(`${t.id}:result`);
        this.seenByParent.add(`${t.id}:result`);
        return { taskId: t.id, agent: this.agentName(t.toAgentId), status: t.status, summary: t.resultSummary };
      });
    const stillRunning = tasks
      .filter((t) => !isTerminal(t.status) && t.status !== 'needs_input')
      .map((t) => ({ taskId: t.id, agent: this.agentName(t.toAgentId), status: t.status, progress: t.progress }));
    const questions = tasks
      .filter((t) => t.status === 'needs_input')
      .map((t) => {
        this.reported.add(`${t.id}:q:${t.question}`);
        this.seenByParent.add(`${t.id}:q:${t.question}`);
        return { taskId: t.id, agent: this.agentName(t.toAgentId), question: t.question };
      });

    const items = this.inbox.get(agentId) ?? [];
    const messages = items.filter((i) => i.kind === 'user' || i.kind === 'parent');
    this.inbox.set(
      agentId,
      items.filter((i) => !messages.includes(i))
    );
    const agent = this.host.getAgent(agentId);
    if (agent)
      this.markDelivered(
        messages.map((m) => m.messageId),
        agent.sessionId
      );
    const userInterventions = this.interventions.get(agentId) ?? [];
    this.interventions.delete(agentId);

    return {
      completed,
      still_running: stillRunning,
      questions,
      messages: messages.map((m) => m.text),
      user_interventions: userInterventions,
      timed_out: timedOut,
      hint: questions.length
        ? 'Answer questions with answer_child, then call wait_for_tasks again.'
        : stillRunning.length
          ? 'Call wait_for_tasks again to keep waiting.'
          : undefined,
    };
  }

  // ---------------------------------------------------------------- session control

  public stopSession(sessionId: string): void {
    for (const task of this.listTasks(sessionId)) {
      if (!isTerminal(task.status)) this.cancelTree(task, 'Session stopped');
    }
    const session = this.host.getSession(sessionId);
    for (const agentId of [...this.inbox.keys()]) {
      if (this.host.getAgent(agentId)?.sessionId === sessionId) this.inbox.delete(agentId);
    }
    if (session) this.host.setSessionStatus(sessionId, 'stopped');
  }

  public pauseSession(sessionId: string): void {
    this.host.setSessionStatus(sessionId, 'paused');
  }

  public async resumeSession(sessionId: string, agentIds: string[]): Promise<void> {
    this.host.setSessionStatus(sessionId, 'active');
    await Promise.all(agentIds.map((id) => this.pump(id)));
  }

  /** Server restart: nothing is running any more (PLAN.md 20). */
  public static interruptStaleTasks(): void {
    getDb()
      .update(tasksTable)
      .set({ status: 'interrupted', endedAt: Date.now() })
      .where(inArray(tasksTable.status, ACTIVE_STATUSES))
      .run();
  }

  public forgetAgent(agentId: string): void {
    this.inbox.delete(agentId);
    this.waits.get(agentId)?.resolve();
    this.interventions.delete(agentId);
  }

  /** Session tool handler factory (bound to the calling agent). */
  public toolHandlers() {
    const ok = (value: unknown) => ({
      content: [{ type: 'text' as const, text: typeof value === 'string' ? value : json(value) }],
    });
    return {
      report_progress: async (args: { text: string }, ctx: { sessionAgentId: string }) =>
        ok(this.reportProgress(ctx.sessionAgentId, args)),
      complete_task: async (
        args: { summary: string; details?: string; files?: string[] },
        ctx: { sessionAgentId: string }
      ) => ok(this.completeTask(ctx.sessionAgentId, args)),
      ask_parent: async (args: { question: string }, ctx: { sessionAgentId: string }) =>
        ok(this.askParent(ctx.sessionAgentId, args)),
      list_agents: async (_args: unknown, ctx: { sessionAgentId: string }) => ok(this.listAgents(ctx.sessionAgentId)),
      spawn_agent: async (args: { agentName: string; alias?: string }, ctx: { sessionAgentId: string }) =>
        ok(await this.spawnAgent(ctx.sessionAgentId, args)),
      delegate_task: async (
        args: { agentId: string; title: string; instructions: string; scope?: string[]; files?: string[] },
        ctx: { sessionAgentId: string }
      ) => ok(await this.delegateTask(ctx.sessionAgentId, args)),
      wait_for_tasks: async (args: { taskIds: string[]; timeoutSec: number }, ctx: { sessionAgentId: string }) =>
        ok(await this.waitForTasks(ctx.sessionAgentId, args)),
      get_task_status: async (args: { taskId: string }, ctx: { sessionAgentId: string }) =>
        ok(this.getTaskStatus(ctx.sessionAgentId, args)),
      get_task_result: async (args: { taskId: string }, ctx: { sessionAgentId: string }) =>
        ok(this.getTaskResult(ctx.sessionAgentId, args)),
      answer_child: async (args: { taskId: string; answer: string }, ctx: { sessionAgentId: string }) =>
        ok(await this.answerChild(ctx.sessionAgentId, args)),
      message_agent: async (args: { agentId: string; message: string }, ctx: { sessionAgentId: string }) =>
        ok(await this.messageAgent(ctx.sessionAgentId, args)),
      cancel_task: async (args: { taskId: string; reason: string }, ctx: { sessionAgentId: string }) =>
        ok(this.cancelTask(ctx.sessionAgentId, args)),
    };
  }
}
