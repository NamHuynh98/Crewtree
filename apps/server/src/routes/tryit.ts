// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply } from 'fastify';
import { TryItService } from '../tryit/TryItService.js';
import { resolveWorkspaceRoot } from '../files/safeFiles.js';
import { validateAgentContent } from '../resources/agents/agentWriter.js';
import { openSse } from './generate.js';

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    reply.code(/not found/i.test(message) ? 404 : /not a known/i.test(message) ? 403 : 400).send({ error: message });
    return undefined;
  }
}

export function registerTryItRoutes(fastify: FastifyInstance) {
  const service = TryItService.getInstance();

  fastify.post('/api/tryit', async (req, reply) => {
    const { content, cwd, allowWrites } = (req.body ?? {}) as { content?: string; cwd?: string; allowWrites?: boolean };
    return handle(reply, () => {
      if (!content) throw new Error('content is required');
      validateAgentContent(content);
      return service.start({ content, cwd: resolveWorkspaceRoot({ cwd }), allowWrites: allowWrites === true });
    });
  });

  fastify.get('/api/tryit/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    let sandbox;
    try {
      sandbox = service.get(id);
    } catch {
      reply.code(404).send({ error: 'Sandbox not found' });
      return;
    }
    const send = openSse(reply);
    // `error` is reserved by EventSource for connection errors
    const unsubscribe = sandbox.subscribe((e) => send(e.type === 'error' ? 'run.error' : e.type, e.data));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    reply.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  fastify.post('/api/tryit/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { content, attachments } = (req.body ?? {}) as { content?: string; attachments?: string[] };
    return handle(reply, async () => {
      if (!content?.trim() && !attachments?.length) throw new Error('Message content is required');
      await service.get(id).send({ text: content ?? '', attachments });
      return { status: 'sent' };
    });
  });

  fastify.post('/api/tryit/:id/permissions/:pid', async (req, reply) => {
    const { id, pid } = req.params as { id: string; pid: string };
    const { allow } = (req.body ?? {}) as { allow?: boolean };
    return handle(reply, () => {
      service.get(id).decide(pid, allow === true);
      return { status: 'decided' };
    });
  });

  fastify.post('/api/tryit/:id/interrupt', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, async () => {
      await service.get(id).interrupt();
      return { status: 'interrupted' };
    });
  });

  fastify.delete('/api/tryit/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, async () => {
      await service.stop(id);
      return { status: 'stopped' };
    });
  });
}
