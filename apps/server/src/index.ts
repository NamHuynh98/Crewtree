// SPDX-License-Identifier: Apache-2.0
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { getDb, closeDb } from './db/index.js';
import { appSettingsTable } from './db/schema.js';
import { eq } from 'drizzle-orm';
import {
  ensureDirectories,
  getConfigPath,
  getPidPath,
  getShutdownTokenPath,
} from './paths.js';
import {
  generateOneTimeToken,
  verifyAndConsumeOneTimeToken,
  createSessionCookie,
  verifySessionCookie,
  getSessionSecret,
} from './auth.js';
import { DEFAULT_PORT, AppSettingsSchema } from '@crewtree/shared';
import { SessionService } from './sessions/SessionService.js';
import { EventBus } from './events/EventBus.js';
import fs from 'fs';
import crypto from 'crypto';

const isDev = process.env.NODE_ENV !== 'production';
const PORT = parseInt(process.env.PORT || `${DEFAULT_PORT}`, 10);
const HOST = '127.0.0.1';

export async function createServer() {
  ensureDirectories();
  const db = getDb();

  const fastify = Fastify({
    logger: isDev ? { level: 'info' } : { level: 'warn' },
  });

  await fastify.register(fastifyCookie, {
    secret: getSessionSecret(),
    parseOptions: {},
  });

  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const url = new URL(origin);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return cb(null, true);
      }
      return cb(new Error('Cross-Origin Request Blocked'), false);
    },
    credentials: true,
  });

  await fastify.register(fastifyWebsocket);

  // Security Check: Host & Origin validation (PLAN.md Section 15.3)
  fastify.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (host) {
      const hostname = host.split(':')[0];
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        reply.code(403).send({ error: 'Invalid Host header' });
        return;
      }
    }

    // Origin check for state-modifying requests
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originUrl = new URL(origin);
          if (originUrl.hostname !== '127.0.0.1' && originUrl.hostname !== 'localhost') {
            reply.code(403).send({ error: 'Invalid Origin header' });
            return;
          }
        } catch {
          reply.code(403).send({ error: 'Malformed Origin' });
          return;
        }
      }
    }

    // Auth check on /api/* (bypass /api/health and /api/version)
    if (req.url.startsWith('/api') && !req.url.startsWith('/api/health') && !req.url.startsWith('/api/version')) {
      const cookie = req.cookies.crewtree_session;
      const isAuthValid = verifySessionCookie(cookie);
      if (!isAuthValid && !isDev) {
        reply.code(401).send({ error: 'Unauthorized: invalid or missing session cookie' });
        return;
      }
    }
  });

  // /auth?t=<one_time_token> Exchange
  fastify.get('/auth', async (req, reply) => {
    const { t } = req.query as { t?: string };
    if (!t || !verifyAndConsumeOneTimeToken(t)) {
      reply.code(400).send('Invalid or expired authentication token. Please launch Crewtree from terminal.');
      return;
    }

    const sessionCookie = createSessionCookie();
    reply.setCookie('crewtree_session', sessionCookie, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: false, // local 127.0.0.1
    });

    reply.redirect('/');
  });

  // /api/health
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      uptime: process.uptime(),
      pid: process.pid,
      claudeReady: true,
    };
  });

  // /api/version
  fastify.get('/api/version', async () => {
    return {
      current: '0.1.0',
      latest: '0.1.0',
      updateAvailable: false,
      releaseUrl: 'https://github.com/crewtree/crewtree/releases',
    };
  });

  // /api/settings
  fastify.get('/api/settings', async () => {
    const row = db.select().from(appSettingsTable).where(eq(appSettingsTable.key, 'global')).get();
    return row ? JSON.parse(row.value) : AppSettingsSchema.parse({});
  });

  fastify.patch('/api/settings', async (req, reply) => {
    const current = db.select().from(appSettingsTable).where(eq(appSettingsTable.key, 'global')).get();
    const currentVal = current ? JSON.parse(current.value) : AppSettingsSchema.parse({});
    const updated = { ...currentVal, ...(req.body as any) };
    const validated = AppSettingsSchema.parse(updated);

    db.insert(appSettingsTable)
      .values({
        key: 'global',
        value: JSON.stringify(validated),
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: appSettingsTable.key,
        set: {
          value: JSON.stringify(validated),
          updatedAt: Date.now(),
        },
      })
      .run();

    return validated;
  });

  // /api/models
  fastify.get('/api/models', async () => {
    return {
      source: 'fallback',
      fetchedAt: Date.now(),
      models: [
        { value: 'opus', displayName: 'Claude 3.7 / 3.5 Opus', description: 'Most capable model for supervisor and complex reasoning' },
        { value: 'sonnet', displayName: 'Claude 3.7 / 3.5 Sonnet', description: 'High performance for coding and analysis' },
        { value: 'haiku', displayName: 'Claude 3.5 Haiku', description: 'Fast and lightweight for specialized tasks' },
      ],
    };
  });

  // Sessions API
  const sessionService = SessionService.getInstance();
  const eventBus = EventBus.getInstance();

  fastify.get('/api/sessions', async () => {
    return sessionService.getSessions();
  });

  fastify.post('/api/sessions', async (req, reply) => {
    const body = req.body as {
      title: string;
      cwd?: string;
      supervisorName?: string;
      supervisorModel?: string;
    };
    const cwd = body.cwd || process.cwd();
    const result = await sessionService.createSession({
      title: body.title || 'New Session',
      cwd,
      supervisorName: body.supervisorName,
      supervisorModel: body.supervisorModel,
    });
    return result;
  });

  fastify.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sessionService.getSession(id);
    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }
    const agents = await sessionService.getSessionAgents(id);
    return { session, agents };
  });

  fastify.post('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { content } = req.body as { content: string };
    if (!content) {
      reply.code(400).send({ error: 'Message content is required' });
      return;
    }
    await sessionService.sendMessageToSupervisor(id, content);
    return { status: 'sent' };
  });

  // /api/shutdown
  fastify.post('/api/shutdown', async (req, reply) => {
    const { token } = req.body as { token?: string };
    const shutdownTokenPath = getShutdownTokenPath();
    if (!fs.existsSync(shutdownTokenPath)) {
      reply.code(400).send({ error: 'Shutdown token not found' });
      return;
    }
    const expectedToken = fs.readFileSync(shutdownTokenPath, 'utf8').trim();
    if (token !== expectedToken) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }

    reply.send({ status: 'shutting down' });
    setTimeout(async () => {
      closeDb();
      await fastify.close();
      process.exit(0);
    }, 100);
  });

  // WebSocket endpoint
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = url.searchParams.get('sessionId') || undefined;
    const lastEventIdStr = url.searchParams.get('lastEventId');

    eventBus.registerClient(socket, sessionId);

    // If reconnecting with lastEventId, catch up missing events
    if (sessionId && lastEventIdStr) {
      const lastEventId = parseInt(lastEventIdStr, 10);
      if (!isNaN(lastEventId)) {
        const missedEvents = eventBus.getEventsAfter(sessionId, lastEventId);
        for (const evt of missedEvents) {
          socket.send(JSON.stringify(evt));
        }
      }
    }

    socket.on('message', (msg: any) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (data.type === 'subscribe' && data.sessionId) {
          eventBus.updateClientSession(socket, data.sessionId);
        }
      } catch {
        // ignore parse error
      }
    });

    socket.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });

  return fastify;
}

async function start() {
  const app = await createServer();

  // Save PID and shutdown token
  fs.writeFileSync(getPidPath(), `${process.pid}`, 'utf8');
  const shutdownToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(getShutdownTokenPath(), shutdownToken, { mode: 0o600, encoding: 'utf8' });

  // Save config
  fs.writeFileSync(getConfigPath(), JSON.stringify({ port: PORT }), 'utf8');

  try {
    await app.listen({ port: PORT, host: HOST });
    const oneTimeToken = generateOneTimeToken();
    console.log(`\n🌲 Crewtree Server running on http://${HOST}:${PORT}`);
    console.log(`🔑 Login Web URL: http://${HOST}:${PORT}/auth?t=${oneTimeToken}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  start();
}
