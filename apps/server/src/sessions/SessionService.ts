// SPDX-License-Identifier: Apache-2.0
import { getDb } from '../db/index.js';
import { sessionsTable, sessionAgentsTable, messagesTable } from '../db/schema.js';
import { Session, SessionAgent, SessionSettingsSchema } from '@crewtree/shared';
import { AgentRuntime } from '../runtime/AgentRuntime.js';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { EventBus } from '../events/EventBus.js';

export class SessionService {
  private static instance: SessionService;
  private activeRuntimes = new Map<string, AgentRuntime>(); // sessionAgentId -> AgentRuntime

  private constructor() {}

  public static getInstance(): SessionService {
    if (!SessionService.instance) {
      SessionService.instance = new SessionService();
    }
    return SessionService.instance;
  }

  public async createSession(params: {
    title: string;
    cwd: string;
    supervisorName?: string;
    supervisorModel?: string;
    projectId?: string;
  }): Promise<{ session: Session; supervisorAgent: SessionAgent }> {
    const db = getDb();
    const sessionId = nanoid();
    const supervisorId = nanoid();
    const now = Date.now();

    const defaultSettings = SessionSettingsSchema.parse({});
    const supervisorName = params.supervisorName || 'crewtree-supervisor';

    const supervisorSnapshot = `---
name: ${supervisorName}
description: Supervisor agent coordinates team tasks
role: supervisor
canDelegate: true
delegates: "*"
---
You are the Supervisor. Coordinate tasks for your team and provide clear, concise responses to the user.`;

    const supervisorAgent: SessionAgent = {
      id: supervisorId,
      sessionId,
      agentName: supervisorName,
      scope: 'crewtree',
      snapshot: supervisorSnapshot,
      parentId: null,
      depth: 0,
      alias: 'Supervisor',
      spawnedBy: 'user',
      modelOverride: params.supervisorModel || null,
      canDelegateOverride: true,
      freshContextOverride: false,
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
      settings: defaultSettings,
      totalTokens: 0,
      totalTurns: 0,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(sessionsTable).values({
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      cwd: session.cwd,
      supervisorAgentId: session.supervisorAgentId,
      status: session.status,
      settings: JSON.stringify(session.settings),
      totalTokens: session.totalTokens,
      totalTurns: session.totalTurns,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }).run();

    db.insert(sessionAgentsTable).values({
      id: supervisorAgent.id,
      sessionId: supervisorAgent.sessionId,
      agentName: supervisorAgent.agentName,
      scope: supervisorAgent.scope,
      snapshot: supervisorAgent.snapshot,
      parentId: supervisorAgent.parentId,
      depth: supervisorAgent.depth,
      alias: supervisorAgent.alias,
      spawnedBy: supervisorAgent.spawnedBy,
      modelOverride: supervisorAgent.modelOverride,
      canDelegateOverride: supervisorAgent.canDelegateOverride,
      freshContextOverride: supervisorAgent.freshContextOverride,
      sdkSessionId: supervisorAgent.sdkSessionId,
      status: supervisorAgent.status,
      lastActiveAt: supervisorAgent.lastActiveAt,
    }).run();

    // Start supervisor runtime
    const runtime = new AgentRuntime({
      sessionId,
      sessionAgent: supervisorAgent,
      cwd: params.cwd,
    });
    await runtime.start();
    this.activeRuntimes.set(supervisorId, runtime);

    return { session, supervisorAgent };
  }

  public async getSessions(): Promise<Session[]> {
    const db = getDb();
    const rows = db.select().from(sessionsTable).all();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      title: r.title,
      cwd: r.cwd,
      supervisorAgentId: r.supervisorAgentId,
      status: r.status as any,
      settings: JSON.parse(r.settings),
      totalTokens: r.totalTokens,
      totalTurns: r.totalTurns,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  public async getSession(id: string): Promise<Session | null> {
    const db = getDb();
    const r = db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).get();
    if (!r) return null;
    return {
      id: r.id,
      projectId: r.projectId,
      title: r.title,
      cwd: r.cwd,
      supervisorAgentId: r.supervisorAgentId,
      status: r.status as any,
      settings: JSON.parse(r.settings),
      totalTokens: r.totalTokens,
      totalTurns: r.totalTurns,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  public async getSessionAgents(sessionId: string): Promise<SessionAgent[]> {
    const db = getDb();
    const rows = db.select().from(sessionAgentsTable).where(eq(sessionAgentsTable.sessionId, sessionId)).all();
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      agentName: r.agentName,
      scope: r.scope as any,
      snapshot: r.snapshot,
      parentId: r.parentId,
      depth: r.depth,
      alias: r.alias,
      spawnedBy: r.spawnedBy as any,
      modelOverride: r.modelOverride,
      canDelegateOverride: r.canDelegateOverride ?? undefined,
      freshContextOverride: r.freshContextOverride ?? undefined,
      sdkSessionId: r.sdkSessionId,
      status: r.status as any,
      lastActiveAt: r.lastActiveAt,
    }));
  }

  public async sendMessageToSupervisor(sessionId: string, text: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    let runtime = this.activeRuntimes.get(session.supervisorAgentId);
    if (!runtime) {
      const agents = await this.getSessionAgents(sessionId);
      const supervisor = agents.find((a) => a.id === session.supervisorAgentId);
      if (!supervisor) throw new Error('Supervisor agent not found');

      runtime = new AgentRuntime({
        sessionId,
        sessionAgent: supervisor,
        cwd: session.cwd,
      });
      await runtime.start();
      this.activeRuntimes.set(supervisor.id, runtime);
    }

    // Record user message in DB
    const db = getDb();
    const messageId = nanoid();
    db.insert(messagesTable).values({
      id: messageId,
      sessionAgentId: session.supervisorAgentId,
      role: 'user',
      content: JSON.stringify([{ type: 'text', text }]),
      delivery: 'delivered',
      createdAt: Date.now(),
    }).run();

    EventBus.getInstance().emitEvent({
      sessionId,
      sessionAgentId: session.supervisorAgentId,
      type: 'message.created',
      payload: { messageId, role: 'user', text },
      ts: Date.now(),
    });

    await runtime.sendMessage(text);
  }
}
