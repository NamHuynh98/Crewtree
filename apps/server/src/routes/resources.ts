// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply } from 'fastify';
import { RESOURCE_KINDS, RESOURCE_SCOPES, type ResourceKind, type ResourceScope } from '@crewtree/shared';
import { ResourceScanner } from '../resources/ResourceScanner.js';
import { AgentWriter } from '../resources/agents/agentWriter.js';
import { Revisions } from '../resources/revisions.js';
import { ProjectService } from '../projects/ProjectService.js';

/** URL kinds are plural (PLAN.md 15.1): agents | skills | commands | memory | mcp | plugins */
const KIND_BY_PATH: Record<string, ResourceKind> = {
  agents: 'agent',
  skills: 'skill',
  commands: 'command',
  memory: 'memory',
  mcp: 'mcp',
  plugins: 'plugin',
};

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    reply.code(/not found/i.test(message) ? 404 : /already exists/i.test(message) ? 409 : 400).send({ error: message });
    return undefined;
  }
}

function kindOf(param: string): ResourceKind {
  const kind = KIND_BY_PATH[param];
  if (!kind || !RESOURCE_KINDS.includes(kind)) throw new Error(`Unknown resource kind not found: ${param}`);
  return kind;
}

/** Writing skills, commands, memory, MCP and plugins arrives with their pages in Phase 6. */
function assertAgents(kind: ResourceKind) {
  if (kind !== 'agent') throw new Error(`Editing ${kind} resources is not available yet`);
}

export function registerResourceRoutes(fastify: FastifyInstance) {
  const scanner = ResourceScanner.getInstance();
  const projects = ProjectService.getInstance();

  // ---------------------------------------------------------------- projects (project switcher)

  fastify.get('/api/projects', async () => ({ current: projects.currentInfo(), recent: projects.list() }));

  fastify.post('/api/projects/open', async (req, reply) => {
    const { path } = (req.body ?? {}) as { path?: string };
    if (!path) {
      reply.code(400).send({ error: 'path is required' });
      return;
    }
    return handle(reply, () => ({ project: projects.open(path), current: projects.currentInfo() }));
  });

  // ---------------------------------------------------------------- resources

  fastify.get('/api/resources/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const { scope } = req.query as { scope?: string };
    return handle(reply, () => {
      const items = scanner.list(kindOf(kind));
      if (scope && !RESOURCE_SCOPES.includes(scope as ResourceScope)) throw new Error(`Unknown scope ${scope}`);
      return scope ? items.filter((i) => i.scope === scope) : items;
    });
  });

  fastify.get('/api/resources/:kind/:id', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    return handle(reply, () => {
      const k = kindOf(kind);
      const detail = scanner.get(id);
      if (detail.kind !== k) throw new Error('Resource not found');
      return { ...detail, revisions: Revisions.list(k, detail.name).map(({ content: _c, ...meta }) => meta) };
    });
  });

  fastify.post('/api/resources/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const { scope, content } = (req.body ?? {}) as { scope?: ResourceScope; content?: string };
    return handle(reply, () => {
      assertAgents(kindOf(kind));
      if (!content) throw new Error('content is required');
      return AgentWriter.create(scope ?? 'user', content);
    });
  });

  fastify.put('/api/resources/:kind/:id', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const { content } = (req.body ?? {}) as { content?: string };
    return handle(reply, () => {
      assertAgents(kindOf(kind));
      if (!content) throw new Error('content is required');
      return AgentWriter.update(id, content);
    });
  });

  fastify.delete('/api/resources/:kind/:id', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    return handle(reply, () => {
      assertAgents(kindOf(kind));
      AgentWriter.delete(id);
      return { status: 'deleted' };
    });
  });

  fastify.post('/api/resources/:kind/:id/duplicate', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const body = (req.body ?? {}) as { scope?: ResourceScope; name?: string };
    return handle(reply, () => {
      assertAgents(kindOf(kind));
      return AgentWriter.duplicate(id, body);
    });
  });

  fastify.post('/api/resources/agents/:id/move', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { scope } = (req.body ?? {}) as { scope?: ResourceScope };
    return handle(reply, () => {
      if (!scope) throw new Error('scope is required');
      return AgentWriter.move(id, scope);
    });
  });

  fastify.post('/api/resources/:kind/:id/rollback', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const { revisionId } = (req.body ?? {}) as { revisionId?: string };
    return handle(reply, () => {
      assertAgents(kindOf(kind));
      if (!revisionId) throw new Error('revisionId is required');
      return AgentWriter.rollback(revisionId, id);
    });
  });

  fastify.get('/api/resources/:kind/:id/revisions/:revisionId', async (req, reply) => {
    const { revisionId } = req.params as { revisionId: string };
    return handle(reply, () => {
      const revision = Revisions.get(revisionId);
      if (!revision) throw new Error('Revision not found');
      return revision;
    });
  });

  // Export .md (UI-WIREFRAMES 7 ⋯ menu)
  fastify.get('/api/resources/agents/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, () => {
      const detail = scanner.get(id);
      if (detail.kind !== 'agent' || detail.content === undefined) throw new Error('Agent not found');
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${detail.name}.md"`);
      return detail.content;
    });
  });

  fastify.post('/api/agents/bulk-model', async (req, reply) => {
    const { ids, model } = (req.body ?? {}) as { ids?: string[]; model?: string };
    return handle(reply, () => {
      if (!ids?.length) throw new Error('ids is required');
      return { results: AgentWriter.bulkModel(ids, model ?? '') };
    });
  });
}
