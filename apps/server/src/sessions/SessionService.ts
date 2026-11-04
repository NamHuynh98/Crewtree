// SPDX-License-Identifier: Apache-2.0
import { getDb } from '../db/index.js';
import { sessionsTable, sessionAgentsTable, messagesTable, eventsTable, fileTouchesTable } from '../db/schema.js';
import {
  Session,
  SessionAgent,
  SessionSettingsSchema,
  SessionStatus,
  type SessionSettings,
  type Task,
} from '@crewtree/shared';
import { AgentRuntime, DriverType, TurnUsage } from '../runtime/AgentRuntime.js';
import type { AgentDriver } from '../runtime/AgentDriver.js';
import { parseAgentSnapshot } from '../runtime/agentDefinition.js';
import { countedTokens } from '../runtime/eventNormalizer.js';
import { ConcurrencyLimiter } from '../runtime/ConcurrencyLimiter.js';
import { TaskHost, TaskManager } from '../runtime/TaskManager.js';
import { createToolHooks, isOutsideScopeRequest } from '../runtime/toolHooks.js';
import { DELEGATION_RULES, SUPERVISOR_PROTOCOL, TASK_PROTOCOL } from '../runtime/prompts.js';
import type { OrchestratorHandlers } from '../runtime/mcp/createAgentMcpServer.js';
import { ApprovalService } from '../approvals/ApprovalService.js';
import { FileActivity } from '../files/FileActivity.js';
import { FileLockManager } from '../files/FileLockManager.js';
import { findLibraryAgent, LibraryAgent } from '../resources/agents/agentLibrary.js';
import { ensureDefaultSupervisor } from '../resources/agents/defaultSupervisor.js';
import { getAppSettings } from '../settings/appSettings.js';
import { deepMerge } from '../lib/deepMerge.js';
import { nanoid } from 'nanoid';
import { eq, inArray, desc, lt, notInArray, isNull, isNotNull, and, sql } from 'drizzle-orm';
import { EventBus } from '../events/EventBus.js';
import { UploadService } from '../uploads/UploadService.js';

/** An agent of the initial tree built in the New session dialog (PLAN.md 4.1). */
export interface InitialAgent {
  agentName: string;
  alias?: string;
  /** Alias or agent name of an agent listed before it; defaults to the Supervisor */
  parent?: string;
  model?: string;
}

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

function canDelegateOf(agent: SessionAgent): boolean {
  return agent.canDelegateOverride ?? parseAgentSnapshot(agent.snapshot, agent.agentName).frontmatter.canDelegate;
}

export class SessionService implements TaskHost {
  private static instance: SessionService;
  private activeRuntimes = new Map<string, AgentRuntime>(); // sessionAgentId -> AgentRuntime
  /** Driver for new runtimes; `CREWTREE_DRIVER=fake|cli|sdk` (unset = SDK with CLI fallback). */
  private driverType = (process.env.CREWTREE_DRIVER as DriverType | undefined) || undefined;
  private eventBus = EventBus.getInstance();
  public readonly taskManager = new TaskManager(this);
  public readonly limiter = new ConcurrencyLimiter((sessionId) => {
    const global = getAppSettings().limits.defaults.maxConcurrentAgents;
    const session = this.getSession(sessionId);
    return { global, session: session?.settings.limits.maxConcurrentAgents ?? global };
  });

  private constructor() {}

  public static getInstance(): SessionService {
    if (!SessionService.instance) {
      SessionService.instance = new SessionService();
      SessionService.instance.reconcileAfterRestart();
    }
    return SessionService.instance;
  }

  /**
   * No process survives a restart: agents with a runtime session become `suspended` (resumable), others
   * `idle`; unfinished tasks become `interrupted`; nobody waits on old approval requests (PLAN.md 20).
   */
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
      TaskManager.interruptStaleTasks();
      ApprovalService.getInstance().expireStale();
    } catch (e) {
      console.error('Failed to reconcile state after restart:', e);
    }
  }

  /** Test hook: build each agent's driver (e.g. scripted FakeDrivers per agent name). */
  private driverFactory?: (agent: SessionAgent, type: DriverType) => AgentDriver;

  public setDriverType(type: DriverType | undefined) {
    this.driverType = type;
  }

  public setDriverFactory(factory: ((agent: SessionAgent, type: DriverType) => AgentDriver) | undefined) {
    this.driverFactory = factory;
  }

  // ------------------------------------------------------------------ TaskHost

  public getSession(id: string): Session | null {
    const r = getDb().select().from(sessionsTable).where(eq(sessionsTable.id, id)).get();
    return r ? rowToSession(r) : null;
  }

  public getAgent(sessionAgentId: string): SessionAgent | undefined {
    const row = getDb().select().from(sessionAgentsTable).where(eq(sessionAgentsTable.id, sessionAgentId)).get();
    return row ? rowToSessionAgent(row) : undefined;
  }

  public getChildren(sessionAgentId: string): SessionAgent[] {
    return getDb()
      .select()
      .from(sessionAgentsTable)
      .where(eq(sessionAgentsTable.parentId, sessionAgentId))
      .all()
      .map(rowToSessionAgent);
  }

  public peekRuntime(sessionAgentId: string): AgentRuntime | undefined {
    return this.activeRuntimes.get(sessionAgentId);
  }

  /** Returns the agent's runtime, creating (not yet starting) it if needed. */
  public async getRuntime(sessionId: string, sessionAgentId: string): Promise<AgentRuntime> {
    const existing = this.activeRuntimes.get(sessionAgentId);
    if (existing) return existing;
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const agent = this.getAgent(sessionAgentId);
    if (!agent || agent.sessionId !== sessionId) throw new Error(`Agent ${sessionAgentId} not found in session`);
    return this.createRuntime(session, agent);
  }

  public async spawnChild(parentId: string, agentName: string, alias?: string): Promise<SessionAgent> {
    const parent = this.getAgent(parentId);
    if (!parent) throw new Error('Unknown parent agent');
    const session = this.getSession(parent.sessionId)!;
    return this.insertAgent(session, parent, agentName, { alias, spawnedBy: 'agent' });
  }

  public setSessionStatus(sessionId: string, status: SessionStatus, extra: Record<string, unknown> = {}): void {
    getDb().update(sessionsTable).set({ status, updatedAt: Date.now() }).where(eq(sessionsTable.id, sessionId)).run();
    this.eventBus.emitEvent({ sessionId, type: 'session.status', payload: { status, ...extra }, ts: Date.now() });
  }

  // ------------------------------------------------------------------ runtimes

  private createRuntime(session: Session, agent: SessionAgent): AgentRuntime {
    const app = getAppSettings();
    const isSupervisor = agent.id === session.supervisorAgentId;
    const canDelegate = isSupervisor || canDelegateOf(agent);
    const promptAppendix = [canDelegate ? DELEGATION_RULES : '', isSupervisor ? SUPERVISOR_PROTOCOL : TASK_PROTOCOL]
      .filter(Boolean)
      .join('\n\n');
    const approvals = ApprovalService.getInstance();

    const runtime = new AgentRuntime({
      sessionId: session.id,
      sessionAgent: agent,
      cwd: session.cwd,
      driverType: this.driverType,
      driverFactory: this.driverFactory ? (type) => this.driverFactory!(agent, type) : undefined,
      configGroups: session.settings.configGroups,
      idleSuspendMinutes: session.settings.idleSuspendMinutes ?? app.limits.defaults.idleSuspendMinutes,
      defaultModel: canDelegate ? app.models.defaults.supervisor : app.models.defaults.worker,
      fallbackModel: app.models.defaults.fallback,
      maxTurns: session.settings.limits.maxTurns,
      promptAppendix,
      limiter: this.limiter,
      mcpHandlers: this.taskManager.toolHandlers() as unknown as Partial<OrchestratorHandlers>,
      hooks: createToolHooks({ sessionId: session.id, agent, cwd: session.cwd, taskManager: this.taskManager }),
      canUseTool: async (toolName, input, onPending) => {
        const outcome = await approvals.request({
          onPending,
          sessionId: session.id,
          sessionAgentId: agent.id,
          tool: toolName,
          input,
          cwd: session.cwd,
          taskId: this.taskManager.currentTask(agent.id)?.id,
          label: isOutsideScopeRequest(agent.id, toolName, input, session.cwd) ? 'outside_scope' : undefined,
        });
        // A denied Bash never reaches PostToolUse: stop attributing file changes to it
        if (!outcome.allow && toolName === 'Bash') FileActivity.getInstance().bashEnded(agent.id);
        return outcome;
      },
      onTurnComplete: (usage) => this.onTurnComplete(session.id, agent.id, usage),
      onError: (error) => this.taskManager.onAgentError(agent.id, error),
    });
    this.activeRuntimes.set(agent.id, runtime);
    FileActivity.getInstance().watchSession(session.id, session.cwd);
    return runtime;
  }

  private onTurnComplete(sessionId: string, agentId: string, usage: TurnUsage) {
    this.recordUsage(sessionId, usage);
    // No Bash command outlives the turn (interrupted or failed commands may skip PostToolUse)
    FileActivity.getInstance().bashEnded(agentId);
    // Edits made outside any task keep their leases only for the turn
    if (!this.taskManager.currentTask(agentId)) FileLockManager.getInstance().releaseAgent(agentId);
    void this.taskManager.onTurnEnd(agentId, usage);
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
    const session = this.getSession(sessionId);
    // maxTokens/session (PLAN.md 4.3): stop handing out new work; running turns finish
    if (session && session.status === 'active' && session.totalTokens >= session.settings.limits.maxTokens) {
      this.setSessionStatus(sessionId, 'paused', { reason: 'maxTokens', totalTokens: session.totalTokens });
    }
  }

  // ------------------------------------------------------------------ tree

  /**
   * Adds an agent from the library under `parent` (user via the UI, or an agent via spawn_agent):
   * the parent must delegate, list it in `delegates`, and the session limits must allow it (PLAN.md 4.2).
   */
  private insertAgent(
    session: Session,
    parent: SessionAgent,
    agentName: string,
    opts: { alias?: string; model?: string; spawnedBy: 'user' | 'agent' }
  ): SessionAgent {
    const isSupervisor = parent.id === session.supervisorAgentId;
    if (!isSupervisor && !canDelegateOf(parent)) {
      throw new Error(`${parent.alias || parent.agentName} cannot delegate, so it cannot have children`);
    }
    const delegates = parseAgentSnapshot(parent.snapshot, parent.agentName).frontmatter.delegates;
    if (delegates !== '*' && !delegates.includes(agentName)) {
      throw new Error(
        `${agentName} is not in the allowed list of ${parent.alias || parent.agentName}: ${delegates.join(', ')}`
      );
    }
    const library = findLibraryAgent(agentName, session.cwd);
    if (!library) throw new Error(`No agent named "${agentName}" in the library`);
    const limits = session.settings.limits;
    if (parent.depth + 1 >= limits.maxDepth) {
      throw new Error(`maxDepth ${limits.maxDepth} reached: ${parent.alias || parent.agentName} cannot have children`);
    }
    const all = getDb().select().from(sessionAgentsTable).where(eq(sessionAgentsTable.sessionId, session.id)).all();
    if (all.length >= limits.maxTotalAgents) throw new Error(`maxTotalAgents ${limits.maxTotalAgents} reached`);

    const taken = new Set(all.map((a) => a.alias || a.agentName));
    let alias = opts.alias || agentName;
    for (let n = 2; taken.has(alias); n++) alias = `${opts.alias || agentName}-${n}`;

    const agent = this.insertAgentRow(session.id, library, {
      parentId: parent.id,
      depth: parent.depth + 1,
      alias,
      model: opts.model,
      spawnedBy: opts.spawnedBy,
    });
    this.eventBus.emitEvent({
      sessionId: session.id,
      sessionAgentId: agent.id,
      type: 'agent.spawned',
      payload: { agent, parentId: parent.id, spawnedBy: opts.spawnedBy, by: parent.alias || parent.agentName },
      ts: Date.now(),
    });
    return agent;
  }

  private insertAgentRow(
    sessionId: string,
    library: LibraryAgent,
    opts: { parentId: string | null; depth: number; alias: string; model?: string; spawnedBy: 'user' | 'agent' }
  ): SessionAgent {
    const agent: SessionAgent = {
      id: nanoid(),
      sessionId,
      agentName: library.name,
      scope: library.scope,
      snapshot: library.content,
      parentId: opts.parentId,
      depth: opts.depth,
      alias: opts.alias,
      spawnedBy: opts.spawnedBy,
      modelOverride: opts.model ?? null,
      canDelegateOverride: null,
      freshContextOverride: null,
      sdkSessionId: null,
      status: 'idle',
      lastActiveAt: Date.now(),
    };
    getDb()
      .insert(sessionAgentsTable)
      .values({ ...agent, alias: agent.alias ?? null })
      .run();
    return agent;
  }

  public async createSession(params: {
    title: string;
    cwd: string;
    supervisorName?: string;
    supervisorModel?: string;
    projectId?: string;
    settings?: SessionSettings;
    agents?: InitialAgent[];
  }): Promise<{ session: Session; supervisorAgent: SessionAgent; agents: SessionAgent[] }> {
    const supervisorDef = params.supervisorName
      ? findLibraryAgent(params.supervisorName, params.cwd)
      : await ensureDefaultSupervisor(params.cwd);
    if (!supervisorDef) throw new Error(`No agent named "${params.supervisorName}" in the library`);
    if (!supervisorDef.frontmatter.canDelegate) {
      throw new Error(`${supervisorDef.name} cannot be the Supervisor: it does not have canDelegate`);
    }

    const now = Date.now();
    const sessionId = nanoid();
    const session: Session = {
      id: sessionId,
      projectId: params.projectId || null,
      title: params.title,
      cwd: params.cwd,
      supervisorAgentId: '',
      status: 'active',
      settings: params.settings ?? this.defaultSettings(),
      totalTokens: 0,
      totalTurns: 0,
      createdAt: now,
      updatedAt: now,
    };

    const supervisorAgent = this.insertAgentRow(sessionId, supervisorDef, {
      parentId: null,
      depth: 0,
      alias: 'Supervisor',
      model: params.supervisorModel,
      spawnedBy: 'user',
    });
    session.supervisorAgentId = supervisorAgent.id;
    getDb()
      .insert(sessionsTable)
      .values({ ...session, settings: JSON.stringify(session.settings) })
      .run();

    try {
      for (const initial of params.agents ?? []) {
        const tree = await this.getSessionAgents(sessionId);
        const parent = initial.parent
          ? tree.find((a) => a.alias === initial.parent || a.agentName === initial.parent)
          : supervisorAgent;
        if (!parent) throw new Error(`Parent "${initial.parent}" of ${initial.agentName} is not in the tree`);
        this.insertAgent(session, parent, initial.agentName, {
          alias: initial.alias,
          model: initial.model,
          spawnedBy: 'user',
        });
      }
    } catch (err) {
      await this.deleteSession(sessionId);
      throw err;
    }

    await this.createRuntime(session, supervisorAgent).start();
    return { session, supervisorAgent, agents: await this.getSessionAgents(sessionId) };
  }

  /** User adds an agent to a running session (drag onto a node, PLAN.md 4.1). */
  public async addAgent(
    sessionId: string,
    params: { agentName: string; parentId?: string; alias?: string; model?: string }
  ): Promise<SessionAgent> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const parent = this.getAgent(params.parentId ?? session.supervisorAgentId);
    if (!parent || parent.sessionId !== sessionId) throw new Error('Parent agent not found in session');
    return this.insertAgent(session, parent, params.agentName, {
      alias: params.alias,
      model: params.model,
      spawnedBy: 'user',
    });
  }

  /** Session overrides: model (from the next turn, context kept) and canDelegate (PLAN.md 7, 6.1). */
  public async updateAgent(
    sessionId: string,
    agentId: string,
    patch: { modelOverride?: string | null; canDelegateOverride?: boolean | null }
  ): Promise<SessionAgent> {
    const agent = this.getAgent(agentId);
    if (!agent || agent.sessionId !== sessionId) throw new Error('Agent not found in session');
    const set: Partial<typeof sessionAgentsTable.$inferInsert> = {};
    if (patch.modelOverride !== undefined) set.modelOverride = patch.modelOverride;
    if (patch.canDelegateOverride !== undefined) set.canDelegateOverride = patch.canDelegateOverride;
    getDb().update(sessionAgentsTable).set(set).where(eq(sessionAgentsTable.id, agentId)).run();

    const runtime = this.activeRuntimes.get(agentId);
    if (runtime && patch.modelOverride !== undefined) await runtime.setModelOverride(patch.modelOverride);
    if (runtime && patch.canDelegateOverride !== undefined) {
      // The tool set changes: rebuild the process (resumed) once the agent is between turns
      if (!runtime.isTurnActive()) {
        this.activeRuntimes.delete(agentId);
        await runtime.dispose();
      }
    }
    return this.getAgent(agentId)!;
  }

  /** Removes an agent and its subtree; their tasks are cancelled (PLAN.md 15.1). */
  public async removeAgent(sessionId: string, agentId: string): Promise<void> {
    const session = this.getSession(sessionId);
    const agent = this.getAgent(agentId);
    if (!session || !agent || agent.sessionId !== sessionId) throw new Error('Agent not found in session');
    if (agentId === session.supervisorAgentId) throw new Error('The Supervisor cannot be removed');
    for (const child of this.getChildren(agentId)) await this.removeAgent(sessionId, child.id);
    for (const task of this.taskManager.listTasks(sessionId)) {
      if (task.toAgentId === agentId) this.taskManager.cancelTree(task, 'Agent removed from the session');
    }
    await this.disposeAgent(agentId);
    getDb().delete(sessionAgentsTable).where(eq(sessionAgentsTable.id, agentId)).run();
    this.eventBus.emitEvent({
      sessionId,
      sessionAgentId: agentId,
      type: 'agent.removed',
      payload: { agentId, name: agent.alias || agent.agentName },
      ts: Date.now(),
    });
  }

  private async disposeAgent(agentId: string) {
    ApprovalService.getInstance().cancelForAgent(agentId, 'Agent removed');
    FileLockManager.getInstance().releaseAgent(agentId);
    this.taskManager.forgetAgent(agentId);
    const runtime = this.activeRuntimes.get(agentId);
    this.activeRuntimes.delete(agentId);
    await runtime?.dispose();
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const agents = await this.getSessionAgents(sessionId);
    this.taskManager.stopSession(sessionId);
    await Promise.all(agents.map((a) => this.disposeAgent(a.id)));
    await FileActivity.getInstance().unwatchSession(sessionId);
    getDb().delete(sessionAgentsTable).where(eq(sessionAgentsTable.sessionId, sessionId)).run();
    getDb().delete(sessionsTable).where(eq(sessionsTable.id, sessionId)).run();
    UploadService.getInstance().removeScope(sessionId);
  }

  // ------------------------------------------------------------------ settings & queries

  private defaultSettings(): SessionSettings {
    // New sessions start from Settings → Limits (UI-WIREFRAMES 13)
    const { defaults, session } = getAppSettings().limits;
    return SessionSettingsSchema.parse({
      idleSuspendMinutes: defaults.idleSuspendMinutes,
      limits: { ...session, maxConcurrentAgents: defaults.maxConcurrentAgents },
    });
  }

  /** Validates a partial settings patch on top of `base` (new sessions: app defaults). */
  public resolveSettings(patch: unknown, base: SessionSettings = this.defaultSettings()) {
    return SessionSettingsSchema.safeParse(deepMerge(base, patch));
  }

  /** Config groups apply from the next agent process start; idleSuspendMinutes and limits apply immediately. */
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
    this.limiter.drain();
    return this.getSession(id)!;
  }

  /**
   * Per-agent counters for the canvas nodes (UI-WIREFRAMES 2 node anatomy): tokens (input + output) and
   * turns from usage events, files touched, and the last tool call as the current activity line.
   */
  public getAgentStats(
    sessionId: string
  ): Record<
    string,
    { tokens: number; turns: number; filesTouched: number; lastTool?: { tool: string; input: unknown; ts: number } }
  > {
    const db = getDb();
    const out: ReturnType<SessionService['getAgentStats']> = {};
    const entry = (id: string) => (out[id] ??= { tokens: 0, turns: 0, filesTouched: 0 });
    const usage = db
      .select({
        agentId: eventsTable.sessionAgentId,
        tokens: sql<number>`sum(coalesce(json_extract(${eventsTable.payload}, '$.inputTokens'), 0) + coalesce(json_extract(${eventsTable.payload}, '$.outputTokens'), 0))`,
        turns: sql<number>`sum(coalesce(json_extract(${eventsTable.payload}, '$.numTurns'), 0))`,
      })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), eq(eventsTable.type, 'usage.updated')))
      .groupBy(eventsTable.sessionAgentId)
      .all();
    for (const u of usage) {
      if (!u.agentId) continue;
      entry(u.agentId).tokens = Number(u.tokens) || 0;
      entry(u.agentId).turns = Number(u.turns) || 0;
    }
    const files = db
      .select({ agentId: fileTouchesTable.sessionAgentId, n: sql<number>`count(distinct ${fileTouchesTable.path})` })
      .from(fileTouchesTable)
      .where(eq(fileTouchesTable.sessionId, sessionId))
      .groupBy(fileTouchesTable.sessionAgentId)
      .all();
    for (const f of files) if (f.agentId) entry(f.agentId).filesTouched = Number(f.n) || 0;
    const lastTools = db
      .select({ agentId: eventsTable.sessionAgentId, payload: eventsTable.payload, ts: eventsTable.ts })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.type, 'agent.tool.start'),
          sql`${eventsTable.id} in (select max(id) from events where session_id = ${sessionId} and type = 'agent.tool.start' group by session_agent_id)`
        )
      )
      .all();
    for (const t of lastTools) {
      if (!t.agentId) continue;
      const p = JSON.parse(t.payload);
      entry(t.agentId).lastTool = { tool: p.tool, input: p.input, ts: t.ts };
    }
    return out;
  }

  /** Agents, tree levels and last agent activity per session, in one query (Sessions page). */
  public getSessionTreeStats(): Map<string, { agentCount: number; levels: number; lastActiveAt: number }> {
    const rows = getDb()
      .select({
        sessionId: sessionAgentsTable.sessionId,
        agentCount: sql<number>`count(*)`,
        maxDepth: sql<number>`max(${sessionAgentsTable.depth})`,
        lastActiveAt: sql<number>`max(${sessionAgentsTable.lastActiveAt})`,
      })
      .from(sessionAgentsTable)
      .groupBy(sessionAgentsTable.sessionId)
      .all();
    return new Map(
      rows.map((r) => [
        r.sessionId,
        { agentCount: Number(r.agentCount), levels: Number(r.maxDepth) + 1, lastActiveAt: Number(r.lastActiveAt) },
      ])
    );
  }

  public async getSessions(): Promise<Session[]> {
    return getDb().select().from(sessionsTable).all().map(rowToSession);
  }

  public async getSessionAgents(sessionId: string): Promise<SessionAgent[]> {
    return getDb()
      .select()
      .from(sessionAgentsTable)
      .where(eq(sessionAgentsTable.sessionId, sessionId))
      .all()
      .map(rowToSessionAgent);
  }

  public getSessionTasks(sessionId: string): Task[] {
    return this.taskManager.listTasks(sessionId);
  }

  /** The `limit` newest messages (before `before`, a createdAt), oldest first. */
  public async getSessionMessages(
    sessionId: string,
    sessionAgentId?: string,
    page: { before?: number; limit?: number } = {}
  ) {
    const agentIds = sessionAgentId ? [sessionAgentId] : (await this.getSessionAgents(sessionId)).map((a) => a.id);
    if (agentIds.length === 0) return [];

    const conditions = [inArray(messagesTable.sessionAgentId, agentIds)];
    if (page.before) conditions.push(lt(messagesTable.createdAt, page.before));
    const rows = getDb()
      .select()
      .from(messagesTable)
      .where(and(...conditions))
      .orderBy(desc(messagesTable.createdAt))
      .limit(page.limit ?? 200)
      .all()
      .reverse();

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
        taskId: r.taskId,
        delivery: r.delivery,
        createdAt: r.createdAt,
      };
    });
  }

  // ------------------------------------------------------------------ user actions

  /** Main chat → Supervisor (root task) or a node's own chat (PLAN.md 4.1, 4.3). */
  public async sendUserMessage(
    sessionId: string,
    agentId: string | undefined,
    text: string,
    mode: 'queue' | 'interrupt' = 'queue'
  ) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.taskManager.userMessage(sessionId, agentId ?? session.supervisorAgentId, text, mode);
  }

  /** The user answers the Supervisor's question on the root task. */
  public async answerRootTask(sessionId: string, taskId: string, answer: string): Promise<Task> {
    const task = this.taskManager.getTask(taskId);
    if (!task || task.sessionId !== sessionId || !task.isRoot) throw new Error('Root task not found in session');
    return this.taskManager.answer(taskId, answer, null);
  }

  public cancelTask(sessionId: string, taskId: string, reason = 'Cancelled by the user'): number {
    const task = this.taskManager.getTask(taskId);
    if (!task || task.sessionId !== sessionId) throw new Error('Task not found in session');
    return this.taskManager.cancelTree(task, reason);
  }

  public async stopSession(sessionId: string): Promise<void> {
    this.taskManager.stopSession(sessionId);
    for (const runtime of this.activeRuntimes.values()) {
      if (runtime.sessionId === sessionId) {
        ApprovalService.getInstance().cancelForAgent(runtime.sessionAgent.id, 'Session stopped');
        await runtime.interrupt();
      }
    }
  }

  public pauseSession(sessionId: string): void {
    this.taskManager.pauseSession(sessionId);
  }

  public async resumeSession(sessionId: string): Promise<void> {
    const agents = await this.getSessionAgents(sessionId);
    await this.taskManager.resumeSession(
      sessionId,
      agents.map((a) => a.id)
    );
  }

  public async interruptAgent(sessionId: string, sessionAgentId: string): Promise<void> {
    const agent = this.getAgent(sessionAgentId);
    if (!agent || agent.sessionId !== sessionId) throw new Error(`Agent ${sessionAgentId} not found in session`);
    await this.activeRuntimes.get(sessionAgentId)?.interrupt();
  }

  // ------------------------------------------------------------------ status

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

  /** Number of agent processes currently alive (Session settings shows it, PLAN.md 3.2). */
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
    await FileActivity.getInstance().closeAll();
  }
}
