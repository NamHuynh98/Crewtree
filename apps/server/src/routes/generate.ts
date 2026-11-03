// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply } from 'fastify';
import { GenerateAgentRequestSchema } from '@crewtree/shared';
import { AgentGenerator } from '../generate/AgentGenerator.js';

/** Server-sent events on a POST response (fetch + ReadableStream on the client). */
export function openSse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export function registerGenerateRoutes(fastify: FastifyInstance) {
  // AI Generate for agents: stream deltas, then the parsed result (PLAN.md 6.4)
  fastify.post('/api/generate/agent', async (req, reply) => {
    const parsed = GenerateAgentRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request', issues: parsed.error.issues });
      return;
    }
    if (parsed.data.mode === 'improve' && !parsed.data.current) {
      reply.code(400).send({ error: 'Improve needs the current definition' });
      return;
    }
    if (parsed.data.mode === 'generate' && !parsed.data.description.trim() && !parsed.data.attachments.length) {
      reply.code(400).send({ error: 'Describe the agent you want' });
      return;
    }

    const send = openSse(reply);
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    try {
      const result = await AgentGenerator.getInstance().generate(parsed.data, {
        signal: abort.signal,
        onDelta: (text) => send('delta', { text }),
      });
      send('result', result);
    } catch (err: any) {
      send('error', { error: err?.message ?? String(err) });
    } finally {
      reply.raw.end();
    }
  });
}
