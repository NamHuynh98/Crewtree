// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import { composeMessage } from '../uploads/composeMessage.js';
import { listChanges } from '../files/SessionChanges.js';
import { childProcessStats } from '../runtime/processStats.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApprovalDecisionSchema, type ApprovalStatus } from '@crewtree/shared';
import { SessionService } from '../sessions/SessionService.js';
import { EventBus } from '../events/EventBus.js';
import { ApprovalService } from '../approvals/ApprovalService.js';
import { ClaudeStatusService } from '../claude/ClaudeStatusService.js';
import { ModelCatalogService } from '../models/ModelCatalogService.js';
import { UsageService } from '../claude/UsageService.js';
import { GitCheckpoint } from '../files/GitCheckpoint.js';
import { getCurrentProjectPath } from '../projects/currentProject.js';

/** Runs `fn`, turning thrown errors into 400 (or 404 for "not found") JSON errors. */
async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    return undefined;
  }
}

/** Sessions, tree, tasks, approvals, models (PLAN.md 15.1). */
export function registerOrchestrationRoutes(fastify: FastifyInstance) {
  const sessions = SessionService.getInstance();
  const approvals = ApprovalService.getInstance();
  const eventBus = EventBus.getInstance();

  // Claude Code login state + whether any agent is rate limited (UI-WIREFRAMES 0 sidebar footer)
  fastify.get('/api/claude/status', async (req) => {
    const { refresh } = req.query as { refresh?: string };
    const account = await ClaudeStatusService.getInstance().getStatus(refresh === '1');
    return { ...account, rateLimited: sessions.hasThrottledAgent() };
  });

  // Plan usage windows of the account (Claude Code `/usage`), for the sidebar meter
  fastify.get('/api/claude/usage', async (req) => {
    const { refresh } = req.query as { refresh?: string };
    return UsageService.getInstance().getUsage(refresh === '1');
  });

  // ---------------------------------------------------------------- models & library

  fastify.get('/api/models', async () => ModelCatalogService.getInstance().getCatalog());
  fastify.post('/api/models/refresh', async () => ModelCatalogService.getInstance().getCatalog(true));

  // ---------------------------------------------------------------- sessions

  // Sessions page rows: agents, tree depth, last activity (UI-WIREFRAMES 0)
  fastify.get('/api/sessions', async () => {
    const stats = sessions.getSessionTreeStats();
    return (await sessions.getSessions())
      .map((s) => ({
        ...s,
        activity: sessions.getSessionActivity(s.id),
        agentCount: stats.get(s.id)?.agentCount ?? 0,
        levels: stats.get(s.id)?.levels ?? 0,
        lastActiveAt: Math.max(s.updatedAt, stats.get(s.id)?.lastActiveAt ?? 0),
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  });

  fastify.post('/api/sessions', async (req, reply) => {
    const body = (req.body ?? {}) as {
      title?: string;
      cwd?: string;
      supervisorName?: string;
      supervisorModel?: string;
      settings?: unknown;
      agents?: Array<{ agentName: string; alias?: string; parent?: string; model?: string }>;
    };
    const cwd = body.cwd || getCurrentProjectPath();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      reply.code(400).send({ error: `Working directory not found: ${cwd}` });
      return;
    }
    const settings = sessions.resolveSettings(body.settings ?? {});
    if (!settings.success) {
      reply.code(400).send({ error: 'Invalid session settings', issues: settings.error.issues });
      return;
    }
    return handle(reply, () =>
      sessions.createSession({
        title: body.title || 'New Session',
        cwd,
        supervisorName: body.supervisorName,
        supervisorModel: body.supervisorModel,
        settings: settings.data,
        agents: body.agents,
      })
    );
  });

  // Session settings: limits, Claude Code config groups, idleSuspendMinutes (PLAN.md 3.6, 15.1)
  fastify.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: string; settings?: unknown };
    const session = sessions.getSession(id);
    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }
    const settings = sessions.resolveSettings(body.settings ?? {}, session.settings);
    if (!settings.success) {
      reply.code(400).send({ error: 'Invalid session settings', issues: settings.error.issues });
      return;
    }
    return sessions.updateSession(id, { title: body.title, settings: settings.data });
  });

  fastify.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.getSession(id);
    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }
    return {
      session,
      agents: (await sessions.getSessionAgents(id)).map((a) => ({
        ...a,
        status: sessions.peekRuntime(a.id)?.getStatus() ?? a.status,
      })),
      tasks: sessions.getSessionTasks(id),
      approvals: approvals.list('pending').filter((a) => a.sessionId === id),
      agentStats: sessions.getAgentStats(id),
      runningProcesses: sessions.getRunningProcessCount(id),
      runningAgents: sessions.limiter.runningCount(id),
    };
  });

  fastify.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, async () => {
      if (!sessions.getSession(id)) throw new Error('Session not found');
      await sessions.deleteSession(id);
      return { status: 'deleted' };
    });
  });

  for (const action of ['stop', 'pause', 'resume'] as const) {
    fastify.post(`/api/sessions/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      return handle(reply, async () => {
        if (!sessions.getSession(id)) throw new Error('Session not found');
        if (action === 'stop') await sessions.stopSession(id);
        else if (action === 'pause') sessions.pauseSession(id);
        else await sessions.resumeSession(id);
        return sessions.getSession(id);
      });
    });
  }

  fastify.get('/api/sessions/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const { after, before, agent, limit, types } = req.query as {
      after?: string;
      before?: string;
      agent?: string;
      limit?: string;
      types?: string;
    };
    const opts = {
      sessionAgentId: agent,
      limit: Math.min(parseInt(limit || '500', 10) || 500, 2000),
      types: types?.split(',').filter(Boolean),
    };
    if (before) return eventBus.getEventsBefore(id, parseInt(before, 10) || 0, opts);
    return eventBus.getEventsAfter(id, parseInt(after || '0', 10) || 0, opts);
  });

  // Stored messages, newest page first (the web chat pages through /events): ?agent=&before=<createdAt>&limit=
  fastify.get('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { agent, before, limit } = req.query as { agent?: string; before?: string; limit?: string };
    if (!sessions.getSession(id)) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }
    return sessions.getSessionMessages(id, agent, {
      before: before ? parseInt(before, 10) || undefined : undefined,
      limit: Math.min(parseInt(limit || '200', 10) || 200, 1000),
    });
  });

  // ---------------------------------------------------------------- tree

  fastify.post('/api/sessions/:id/agents', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { agentName?: string; parentId?: string; alias?: string; model?: string };
    if (!body.agentName) {
      reply.code(400).send({ error: 'agentName is required' });
      return;
    }
    return handle(reply, () =>
      sessions.addAgent(id, {
        agentName: body.agentName!,
        parentId: body.parentId,
        alias: body.alias,
        model: body.model,
      })
    );
  });

  fastify.patch('/api/sessions/:id/agents/:said', async (req, reply) => {
    const { id, said } = req.params as { id: string; said: string };
    const body = (req.body ?? {}) as { modelOverride?: string | null; canDelegateOverride?: boolean | null };
    return handle(reply, () => sessions.updateAgent(id, said, body));
  });

  fastify.delete('/api/sessions/:id/agents/:said', async (req, reply) => {
    const { id, said } = req.params as { id: string; said: string };
    return handle(reply, async () => {
      await sessions.removeAgent(id, said);
      return { status: 'removed' };
    });
  });

  // ---------------------------------------------------------------- messages

  const sendMessage = (sessionId: string, agentId: string | undefined, body: any, reply: FastifyReply) => {
    const { content, mode, attachments } = (body ?? {}) as {
      content?: string;
      mode?: 'queue' | 'interrupt';
      attachments?: string[];
    };
    if (!content?.trim() && !attachments?.length) {
      reply.code(400).send({ error: 'Message content is required' });
      return;
    }
    return handle(reply, () => {
      const session = sessions.getSession(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      // Composer chips and attachments become explicit text (PLAN.md 8)
      const text = composeMessage({ text: content ?? '', attachments }, session.cwd);
      return sessions.sendUserMessage(sessionId, agentId, text, mode === 'interrupt' ? 'interrupt' : 'queue');
    });
  };

  fastify.post('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    return sendMessage(id, undefined, req.body, reply);
  });

  fastify.post('/api/sessions/:id/agents/:said/messages', async (req, reply) => {
    const { id, said } = req.params as { id: string; said: string };
    return sendMessage(id, said, req.body, reply);
  });

  fastify.post('/api/sessions/:id/agents/:said/interrupt', async (req, reply) => {
    const { id, said } = req.params as { id: string; said: string };
    return handle(reply, async () => {
      await sessions.interruptAgent(id, said);
      return { status: 'interrupted' };
    });
  });

  // ---------------------------------------------------------------- tasks

  fastify.get('/api/sessions/:id/tasks', async (req) => {
    const { id } = req.params as { id: string };
    return sessions.getSessionTasks(id);
  });

  fastify.post('/api/sessions/:id/tasks/:tid/answer', async (req, reply) => {
    const { id, tid } = req.params as { id: string; tid: string };
    const { answer } = (req.body ?? {}) as { answer?: string };
    if (!answer) {
      reply.code(400).send({ error: 'answer is required' });
      return;
    }
    return handle(reply, () => sessions.answerRootTask(id, tid, answer));
  });

  fastify.get('/api/sessions/:id/tasks/:tid/result', async (req, reply) => {
    const { id, tid } = req.params as { id: string; tid: string };
    return handle(reply, () => {
      const task = sessions.taskManager.getTask(tid);
      if (!task || task.sessionId !== id) throw new Error('Task not found');
      return task;
    });
  });

  fastify.post('/api/sessions/:id/tasks/:tid/cancel', async (req, reply) => {
    const { id, tid } = req.params as { id: string; tid: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    return handle(reply, () => ({ cancelled: sessions.cancelTask(id, tid, reason || 'Cancelled by the user') }));
  });

  // Files changed by the session's agents (tab Changes, drawer Changes; PLAN.md 9)
  fastify.get('/api/sessions/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { agent } = req.query as { agent?: string };
    return handle(reply, async () => {
      const session = sessions.getSession(id);
      if (!session) throw new Error('Session not found');
      return listChanges(id, session.cwd, agent);
    });
  });

  // Session settings "Processes … RAM" (UI-WIREFRAMES 2)
  fastify.get('/api/sessions/:id/processes', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, async () => {
      if (!sessions.getSession(id)) throw new Error('Session not found');
      const agents = await sessions.getSessionAgents(id);
      const statusOf = (a: (typeof agents)[number]) => sessions.peekRuntime(a.id)?.getStatus() ?? a.status;
      return {
        running: sessions.getRunningProcessCount(id),
        suspended: agents.filter((a) => statusOf(a) === 'suspended').length,
        // Every Claude Code process Crewtree started, across sessions
        all: await childProcessStats(),
      };
    });
  });

  // ---------------------------------------------------------------- checkpoints (PLAN.md 5.4)

  fastify.get('/api/sessions/:id/checkpoints', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, async () => {
      const session = sessions.getSession(id);
      if (!session) throw new Error('Session not found');
      return (await GitCheckpoint.isRepo(session.cwd)) ? GitCheckpoint.list(session.cwd, id) : [];
    });
  });

  fastify.post('/api/sessions/:id/checkpoints/:n/restore', async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    return handle(reply, async () => {
      const session = sessions.getSession(id);
      if (!session) throw new Error('Session not found');
      const checkpoint = (await GitCheckpoint.list(session.cwd, id)).find((c) => String(c.n) === n);
      if (!checkpoint) throw new Error('Checkpoint not found');
      await GitCheckpoint.restore(session.cwd, checkpoint.ref);
      return { status: 'restored', checkpoint };
    });
  });

  // ---------------------------------------------------------------- approvals (PLAN.md 10)

  fastify.get('/api/approvals', async (req) => {
    const { status } = req.query as { status?: ApprovalStatus };
    // Approval Inbox rows name the agent and the session (UI-WIREFRAMES 5)
    return approvals.list(status).map((a) => {
      const agent = sessions.getAgent(a.sessionAgentId);
      return {
        ...a,
        agentName: agent ? agent.alias || agent.agentName : undefined,
        sessionTitle: sessions.getSession(a.sessionId)?.title,
      };
    });
  });

  fastify.post('/api/approvals/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ApprovalDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid decision', issues: parsed.error.issues });
      return;
    }
    return handle(reply, () => approvals.decide(id, parsed.data));
  });
}
