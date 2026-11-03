// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply } from 'fastify';
import { RESOURCE_KINDS, RESOURCE_SCOPES, type ResourceKind, type ResourceScope } from '@crewtree/shared';
import { ResourceScanner } from '../resources/ResourceScanner.js';
import { AgentWriter } from '../resources/agents/agentWriter.js';
import { Revisions } from '../resources/revisions.js';
import { ProjectService } from '../projects/ProjectService.js';
import { CommandWriter, MemoryWriter, SkillWriter, skillFiles } from '../resources/writers/configWriters.js';
import { McpService, projectServerApproval } from '../resources/mcp/McpService.js';
import { PluginService } from '../resources/plugins/PluginService.js';

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
      const meta = (revs: Array<{ content: string }>) => revs.map(({ content: _c, ...m }) => m);
      switch (k) {
        case 'skill':
          return {
            ...detail,
            files: skillFiles(String(detail.metadata.dir)),
            usedBy: scanner
              .list('agent')
              .filter((a) => ((a.metadata.skills as string[] | undefined) ?? []).includes(detail.name))
              .map((a) => a.name),
            revisions: meta(SkillWriter.history(id, 'SKILL.md')),
          };
        case 'command':
          return { ...detail, revisions: meta(CommandWriter.history(id)) };
        case 'memory':
          return { ...detail, revisions: meta(MemoryWriter.history(id)) };
        case 'mcp':
          return {
            ...detail,
            approval: detail.scope === 'project' ? projectServerApproval(detail.name) : undefined,
            revisions: meta(Revisions.list('mcp', `${detail.scope}/${detail.name}`)),
          };
        case 'plugin':
          return { ...detail, details: PluginService.details(detail.name), revisions: [] };
        default:
          return { ...detail, revisions: meta(Revisions.list(k, detail.name)) };
      }
    });
  });

  // Create: agent {scope, content} · command {scope, name, content} · skill {scope, files} ·
  // memory {target, content, fileName?} · mcp {scope, name, config}
  fastify.post('/api/resources/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const body = (req.body ?? {}) as Record<string, any>;
    return handle(reply, async () => {
      switch (kindOf(kind)) {
        case 'agent':
          if (!body.content) throw new Error('content is required');
          return AgentWriter.create(body.scope ?? 'user', body.content);
        case 'command':
          if (!body.name || typeof body.content !== 'string') throw new Error('name and content are required');
          return { item: CommandWriter.create(body.scope ?? 'user', body.name, body.content) };
        case 'skill':
          if (!Array.isArray(body.files)) throw new Error('files are required');
          return { item: SkillWriter.create(body.scope ?? 'user', body.files) };
        case 'memory':
          return { item: MemoryWriter.create(body.target ?? 'project', String(body.content ?? ''), body.fileName) };
        case 'mcp':
          return McpService.save({
            scope: body.scope ?? 'local',
            name: String(body.name ?? ''),
            config: body.config ?? {},
          });
        default:
          throw new Error('Plugins are installed from the marketplace');
      }
    });
  });

  // Update: content (agent, command, memory), {path, content} (skill files), {name, config} (mcp)
  fastify.put('/api/resources/:kind/:id', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const body = (req.body ?? {}) as Record<string, any>;
    return handle(reply, async () => {
      const k = kindOf(kind);
      if (k === 'mcp') {
        const item = scanner.find(id);
        if (!item || item.kind !== 'mcp') throw new Error('MCP server not found');
        return McpService.save({
          scope: item.scope,
          name: String(body.name ?? item.name),
          config: body.config ?? {},
          originalName: item.name,
        });
      }
      if (typeof body.content !== 'string') throw new Error('content is required');
      if (k === 'agent') return AgentWriter.update(id, body.content);
      if (k === 'command') return { item: CommandWriter.update(id, body.content) };
      if (k === 'memory') return { item: MemoryWriter.update(id, body.content) };
      if (k === 'skill') return { item: SkillWriter.writeFile(id, String(body.path ?? 'SKILL.md'), body.content) };
      throw new Error('Plugins are read-only');
    });
  });

  fastify.delete('/api/resources/:kind/:id', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const { path: filePath } = req.query as { path?: string };
    return handle(reply, async () => {
      const k = kindOf(kind);
      if (k === 'agent') AgentWriter.delete(id);
      else if (k === 'command') CommandWriter.delete(id);
      else if (k === 'memory') MemoryWriter.delete(id);
      else if (k === 'skill') {
        if (filePath && filePath !== 'SKILL.md') SkillWriter.deleteFile(id, filePath);
        else SkillWriter.delete(id);
      } else if (k === 'mcp') {
        const item = scanner.find(id);
        if (!item) throw new Error('MCP server not found');
        await McpService.remove(item.scope, item.name);
      } else throw new Error('Uninstall plugins from the Plugins page');
      return { status: 'deleted' };
    });
  });

  // Supporting files of a skill (UI-WIREFRAMES 9 file tree)
  fastify.get('/api/resources/skills/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    return handle(reply, () => {
      if (!filePath) throw new Error('path is required');
      return {
        ...SkillWriter.readFile(id, filePath),
        revisions: SkillWriter.history(id, filePath).map(({ content: _c, ...m }) => m),
      };
    });
  });

  fastify.post('/api/resources/:kind/:id/duplicate', async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const body = (req.body ?? {}) as { scope?: ResourceScope; name?: string };
    return handle(reply, () => {
      if (kindOf(kind) !== 'agent') throw new Error('Only agents can be duplicated');
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
      const k = kindOf(kind);
      if (!revisionId) throw new Error('revisionId is required');
      if (k === 'agent') return AgentWriter.rollback(revisionId, id);
      const revision = Revisions.get(revisionId);
      if (!revision || revision.kind !== k) throw new Error('Revision not found');
      if (k === 'command') return { item: CommandWriter.update(id, revision.content, 'rollback') };
      if (k === 'memory') return { item: MemoryWriter.update(id, revision.content, 'rollback') };
      if (k === 'skill') {
        const item = scanner.find(id);
        if (!item) throw new Error('skill not found');
        const rel = revision.name.slice(item.name.length + 1);
        return { item: SkillWriter.writeFile(id, rel, revision.content, 'rollback') };
      }
      // MCP revisions are masked; restoring one would lose its secrets
      throw new Error(`Rollback is not available for ${k}`);
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

  fastify.get('/api/revisions/:revisionId', async (req, reply) => {
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

  // ---------------------------------------------------------------- MCP (UI-WIREFRAMES 11)

  fastify.post('/api/mcp/test', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; scope?: string; name?: string; config?: any };
    return handle(reply, () => McpService.test(body));
  });

  fastify.post('/api/mcp/:id/enabled', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    return handle(reply, () => {
      const item = scanner.find(id);
      if (!item || item.kind !== 'mcp') throw new Error('MCP server not found');
      if (item.scope !== 'project') throw new Error('Only project (.mcp.json) servers can be turned on or off here');
      McpService.setProjectServerEnabled(item.name, enabled === true);
      return { approval: projectServerApproval(item.name) };
    });
  });

  // ---------------------------------------------------------------- plugins (UI-WIREFRAMES 12)

  fastify.post('/api/plugins/enabled', async (req, reply) => {
    const { id, enabled } = (req.body ?? {}) as { id?: string; enabled?: boolean };
    return handle(reply, async () => {
      if (!id) throw new Error('id is required');
      await PluginService.setEnabled(id, enabled === true);
      return { status: 'ok' };
    });
  });

  fastify.post('/api/plugins/install', async (req, reply) => {
    const { id, scope } = (req.body ?? {}) as { id?: string; scope?: 'user' | 'project' | 'local' };
    return handle(reply, async () => {
      if (!id) throw new Error('id is required');
      return { output: await PluginService.install(id, scope ?? 'user') };
    });
  });

  fastify.post('/api/plugins/uninstall', async (req, reply) => {
    const { id } = (req.body ?? {}) as { id?: string };
    return handle(reply, async () => {
      if (!id) throw new Error('id is required');
      return { output: await PluginService.uninstall(id) };
    });
  });

  fastify.post('/api/plugins/scaffold', async (req, reply) => {
    const { name, files } = (req.body ?? {}) as { name?: string; files?: Array<{ path: string; content: string }> };
    return handle(reply, () => PluginService.scaffold(name ?? '', files ?? []));
  });

  fastify.get('/api/plugins/marketplaces', async (_req, reply) => handle(reply, () => PluginService.marketplaces()));

  fastify.post('/api/plugins/marketplaces', async (req, reply) => {
    const { source } = (req.body ?? {}) as { source?: string };
    return handle(reply, async () => ({ output: await PluginService.addMarketplace(source ?? '') }));
  });

  fastify.post('/api/plugins/marketplaces/update', async (_req, reply) =>
    handle(reply, async () => ({ output: await PluginService.updateMarketplaces() }))
  );
}
