// SPDX-License-Identifier: Apache-2.0
import { getDb } from '../db/index.js';
import { sessionsTable, sessionAgentsTable, messagesTable } from '../db/schema.js';
import { Session, SessionAgent, SessionSettingsSchema, DEFAULT_SUPERVISOR_NAME } from '@crewtree/shared';
import { AgentRuntime, DriverType, TurnUsage } from '../runtime/AgentRuntime.js';
import { parseAgentSnapshot } from '../runtime/agentDefinition.js';
import { countedTokens } from '../runtime/eventNormalizer.js';
import { getAppSettings } from '../settings/appSettings.js';
import { deepMerge } from '../lib/deepMerge.js';
import type { SessionSettings } from '@crewtree/shared';
import { nanoid } from 'nanoid';
import { eq, inArray, asc, notInArray, isNull, isNotNull, and, sql } from 'drizzle-orm';
import { EventBus } from '../events/EventBus.js';

/** Template of PLAN.md Appendix A.1. Creating it in ~/.crewtree/agents with the best model is Phase 2. */
const DEFAULT_SUPERVISOR_SNAPSHOT = `---
name: ${DEFAULT_SUPERVISOR_NAME}
description: Default Crewtree supervisor. Understands the user's goal, splits it into tasks, delegates to child agents, and reports back.
role: supervisor
tools: Read, Grep, Glob
canDelegate: true
delegates: "*"
color: violet
icon: crown
---
You are the Supervisor of a team of AI agents working in the same project directory.

Your job:
1. Understand the user's goal. If it is ambiguous in a way that changes the work, ask the user (ask_parent) before delegating.
2. Call list_agents to see your team. Pick agents by their descriptions. Spawn more only from your allowed list when truly needed.
3. Break the goal into tasks with clear outcomes. For every task that edits files, set \`scope\` to the files/folders it may touch.
   Never give two running tasks overlapping scopes.
4. Run independent tasks in parallel; run dependent tasks in order.
5. Use wait_for_tasks to collect results. Answer child questions with answer_child. Read full results with get_task_result only when the summary is not enough.
6. Do not do the children's work yourself. You may read files to plan and to verify.
7. When done, give the user a concise report: what was done, by whom, files changed, open issues, suggested next steps.`;

function rowToSession(r: typeof sessionsTable.$inferSelect): Session {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    cwd: r.cwd,
    supervisorAgentId: r.supervisorAgentId,
    status: r.status as Session['status'],
    settings: SessionSettingsSchema.parse(JSON.parse(r.settings)),
    totalTokens: r.totalTokens,
    totalTurns: r.totalTurns,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToSessionAgent(r: typeof sessionAgentsTable.$inferSelect): SessionAgent {
  return {
    id: r.id,
    sessionId: r.sessionId,
    agentName: r.agentName,
    scope: r.scope as SessionAgent['scope'],
    snapshot: r.snapshot,
    parentId: r.parentId,
    depth: r.depth,
    alias: r.alias,
    spawnedBy: r.spawnedBy as SessionAgent['spawnedBy'],
    modelOverride: r.modelOverride,
    canDelegateOverride: r.canDelegateOverride ?? undefined,
    freshContextOverride: r.freshContextOverride ?? undefined,
    sdkSessionId: r.sdkSessionId,
    status: r.status as SessionAgent['status'],
    lastActiveAt: r.lastActiveAt,
  };
}

export class SessionService {
  private static instance: SessionService;
  private activeRuntimes = new Map<string, AgentRuntime>(); // sessionAgentId -> AgentRuntime
  /** Driver for new runtimes; `CREWTREE_DRIVER=fake|cli|sdk` (unset = SDK with CLI fallback). */
  private driverType = (process.env.CREWTREE_DRIVER as DriverType | undefined) || undefined;

  private constructor() {}

  public static getInstance(): SessionService {
    if (!SessionService.instance) {
      SessionService.instance = new SessionService();
      SessionService.instance.reconcileAfterRestart();
    }
    return SessionService.instance;
  }

  /** No process survives a restart: agents with a runtime session become `suspended` (resumable), others `idle`. */
  private reconcileAfterRestart() {
    try {
      const db = getDb();
      const settled = ['idle', 'suspended', 'error'];
      db.update(sessionAgentsTable)
        .set({ status: 'suspended' })
        .where(and(notInArray(sessionAgentsTable.status, settled), isNotNull(sessionAgentsTable.sdkSessionId)))
        .run();
      db.update(sessionAgentsTable)
        .set({ status: 'idle' })
        .where(and(notInArray(sessionAgentsTable.status, settled), isNull(sessionAgentsTable.sdkSessionId)))
        .run();
    } catch (e) {
      console.error('Failed to reconcile stale session agent statuses:', e);
    }
  }

  public setDriverType(type: DriverType | undefined) {
    this.driverType = type;
  }

  private createRuntime(session: Session, agent: SessionAgent): AgentRuntime {
    const app = getAppSettings();
    const isCoordinator =
      agent.id === session.supervisorAgentId ||
      (agent.canDelegateOverride ?? parseAgentSnapshot(agent.snapshot, agent.agentName).frontmatter.canDelegate);

    const runtime = new AgentRuntime({
      sessionId: session.id,
      sessionAgent: agent,
      cwd: session.cwd,
      driverType: this.driverType,
      configGroups: session.settings.configGroups,
      idleSuspendMinutes: session.settings.idleSuspendMinutes ?? app.limits.defaults.idleSuspendMinutes,
      defaultModel: isCoordinator ? app.models.defaults.supervisor : app.models.defaults.worker,
      onTurnComplete: (usage) => this.recordUsage(session.id, usage),
    });
    this.activeRuntimes.set(agent.id, runtime);
    return runtime;
  }

  private recordUsage(sessionId: string, usage: TurnUsage) {
    getDb()
      .update(sessionsTable)
      .set({
        totalTokens: sql`${sessionsTable.totalTokens} + ${countedTokens(usage)}`,
        totalTurns: sql`${sessionsTable.totalTurns} + ${usage.numTurns}`,
        updatedAt: Date.now(),
      })
      .where(eq(sessionsTable.id, sessionId))
      .run();
  }

  /** Returns the agent's runtime, creating (not yet starting) it if needed. */
  private async getRuntime(sessionId: string, sessionAgentId: string): Promise<AgentRuntime> {
    const existing = this.activeRuntimes.get(sessionAgentId);
    if (existing) return existing;

    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const row = getDb().select().from(sessionAgentsTable).where(eq(sessionAgentsTable.id, sessionAgentId)).get();
    if (!row || row.sessionId !== sessionId) throw new Error(`Agent ${sessionAgentId} not found in session`);
    return this.createRuntime(session, rowToSessionAgent(row));
  }

  public async createSession(params: {
    title: string;
    cwd: string;
    supervisorName?: string;
    supervisorModel?: string;
    projectId?: string;
    settings?: SessionSettings;
  }): Promise<{ session: Session; supervisorAgent: SessionAgent }> {
    const db = getDb();
    const sessionId = nanoid();
    const supervisorId = nanoid();
    const now = Date.now();

    const supervisorAgent: SessionAgent = {
      id: supervisorId,
      sessionId,
      agentName: params.supervisorName || DEFAULT_SUPERVISOR_NAME,
      scope: 'crewtree',
      snapshot: DEFAULT_SUPERVISOR_SNAPSHOT,
      parentId: null,
      depth: 0,
      alias: 'Supervisor',
      spawnedBy: 'user',
      modelOverride: params.supervisorModel || null,
      canDelegateOverride: null,
      freshContextOverride: null,
      sdkSessionId: null,
      status: 'idle',
      lastActiveAt: now,
    };

    const session: Session = {
      id: sessionId,
      projectId: params.projectId || null,
      title: params.title,
      cwd: params.cwd,
      supervisorAgentId: supervisorId,
      status: 'active',
      settings: params.settings ?? this.defaultSettings(),
      totalTokens: 0,
      totalTurns: 0,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(sessionsTable)
      .values({ ...session, settings: JSON.stringify(session.settings) })
      .run();
    db.insert(sessionAgentsTable)
      .values({ ...supervisorAgent, alias: supervisorAgent.alias ?? null })
      .run();

    const runtime = this.createRuntime(session, supervisorAgent);
    await runtime.start();

    return { session, supervisorAgent };
  }

  private defaultSettings(): SessionSettings {
    return SessionSettingsSchema.parse({ idleSuspendMinutes: getAppSettings().limits.defaults.idleSuspendMinutes });
  }

  /** Validates a partial settings patch on top of `base` (new sessions: app defaults). */
  public resolveSettings(patch: unknown, base: SessionSettings = this.defaultSettings()) {
    return SessionSettingsSchema.safeParse(deepMerge(base, patch));
  }

  /** Config groups apply from the next agent process start; idleSuspendMinutes applies immediately. */
  public async updateSession(id: string, patch: { title?: string; settings: SessionSettings }): Promise<Session> {
    getDb()
      .update(sessionsTable)
      .set({
        ...(patch.title ? { title: patch.title } : {}),
        settings: JSON.stringify(patch.settings),
        updatedAt: Date.now(),
      })
      .where(eq(sessionsTable.id, id))
      .run();
    for (const runtime of this.activeRuntimes.values()) {
      if (runtime.sessionId === id) {
        runtime.updateSettings({
          configGroups: patch.settings.configGroups,
          idleSuspendMinutes: patch.settings.idleSuspendMinutes,
        });
      }
    }
    return (await this.getSession(id))!;
  }

  public async getSessions(): Promise<Session[]> {
    return getDb().select().from(sessionsTable).all().map(rowToSession);
  }

  public async getSession(id: string): Promise<Session | null> {
    const r = getDb().select().from(sessionsTable).where(eq(sessionsTable.id, id)).get();
    return r ? rowToSession(r) : null;
  }

  public async getSessionAgents(sessionId: string): Promise<SessionAgent[]> {
    return getDb()
      .select()
      .from(sessionAgentsTable)
      .where(eq(sessionAgentsTable.sessionId, sessionId))
      .all()
      .map(rowToSessionAgent);
  }

  public async getSessionMessages(sessionId: string, sessionAgentId?: string) {
    const agentIds = sessionAgentId ? [sessionAgentId] : (await this.getSessionAgents(sessionId)).map((a) => a.id);
    if (agentIds.length === 0) return [];

    const rows = getDb()
      .select()
      .from(messagesTable)
      .where(inArray(messagesTable.sessionAgentId, agentIds))
      .orderBy(asc(messagesTable.createdAt))
      .all();

    return rows.map((r) => {
      let contentText = '';
      try {
        const parsed = JSON.parse(r.content);
        if (Array.isArray(parsed)) {
          contentText = parsed.map((p: any) => p.text || '').join('');
        } else if (typeof parsed === 'string') {
          contentText = parsed;
        }
      } catch {
        contentText = r.content;
      }
      return {
        id: r.id,
        sessionAgentId: r.sessionAgentId,
        role: r.role as 'user' | 'assistant' | 'system',
        content: contentText,
        createdAt: r.createdAt,
      };
    });
  }

  /** Each user message to the Supervisor starts a new root task (PLAN.md 4.1). */
  public async sendMessageToSupervisor(sessionId: string, text: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    await this.sendMessageToAgent(sessionId, session.supervisorAgentId, text, { newTask: true });
  }

  public async sendMessageToAgent(
    sessionId: string,
    sessionAgentId: string,
    text: string,
    opts: { newTask?: boolean } = {}
  ): Promise<void> {
    const runtime = await this.getRuntime(sessionId, sessionAgentId);

    const messageId = nanoid();
    getDb()
      .insert(messagesTable)
      .values({
        id: messageId,
        sessionAgentId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text }]),
        delivery: 'delivered',
        createdAt: Date.now(),
      })
      .run();

    EventBus.getInstance().emitEvent({
      sessionId,
      sessionAgentId,
      type: 'message.created',
      payload: { messageId, role: 'user', text },
      ts: Date.now(),
    });

    await runtime.sendMessage(text, opts);
  }

  public async interruptAgent(sessionId: string, sessionAgentId: string): Promise<void> {
    const runtime = this.activeRuntimes.get(sessionAgentId);
    if (!runtime) return;
    const agents = await this.getSessionAgents(sessionId);
    if (!agents.some((a) => a.id === sessionAgentId)) throw new Error(`Agent ${sessionAgentId} not found in session`);
    await runtime.interrupt();
  }

  /** Number of agent processes currently alive (Session settings shows it, PLAN.md 3.2). */
  /** `running` while any agent of the session is working (UI legend ●), else `idle`. */
  public getSessionActivity(sessionId: string): 'running' | 'idle' {
    for (const runtime of this.activeRuntimes.values()) {
      if (runtime.sessionId !== sessionId) continue;
      if (runtime.isTurnActive() || ['running', 'waiting_input', 'waiting_children'].includes(runtime.getStatus())) {
        return 'running';
      }
    }
    return 'idle';
  }

  /** Any agent currently waiting on an account rate limit (sidebar shows "rate limited"). */
  public hasThrottledAgent(): boolean {
    return [...this.activeRuntimes.values()].some((r) => r.getStatus() === 'throttled');
  }

  public getRunningProcessCount(sessionId?: string): number {
    let count = 0;
    for (const runtime of this.activeRuntimes.values()) {
      if (runtime.getDriver() && (!sessionId || runtime.sessionId === sessionId)) count++;
    }
    return count;
  }

  public async disposeAll(): Promise<void> {
    const runtimes = [...this.activeRuntimes.values()];
    this.activeRuntimes.clear();
    await Promise.allSettled(runtimes.map((r) => r.dispose()));
  }
}
