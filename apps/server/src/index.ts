// SPDX-License-Identifier: Apache-2.0
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './db/index.js';
import { appSettingsTable } from './db/schema.js';
import {
  ensureDirectories,
  getClaudeDir,
  getConfigPath,
  getCrewtreeDir,
  getPidPath,
  getShutdownTokenPath,
} from './paths.js';
import { cleanupEvents, scheduleCleanup, stopCleanup } from './settings/maintenance.js';
import { ClaudeStatusService } from './claude/ClaudeStatusService.js';
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
import { getAppSettings } from './settings/appSettings.js';
import { registerOrchestrationRoutes } from './routes/orchestration.js';
import { registerResourceRoutes } from './routes/resources.js';
import { registerFileRoutes } from './routes/files.js';
import { registerGenerateRoutes } from './routes/generate.js';
import { registerTryItRoutes } from './routes/tryit.js';
import { TryItService } from './tryit/TryItService.js';
import { ResourceWatcher } from './resources/ResourceWatcher.js';
import { ProjectService } from './projects/ProjectService.js';
import { ensureDefaultSupervisor } from './resources/agents/defaultSupervisor.js';
import { getCurrentProjectPath } from './projects/currentProject.js';
import { deepMerge } from './lib/deepMerge.js';
import fs from 'fs';
import crypto from 'crypto';

const isDev = process.env.NODE_ENV !== 'production';
const PORT = parseInt(process.env.PORT || `${DEFAULT_PORT}`, 10);
const HOST = '127.0.0.1';
/** Vite dev server port, allowed as Host/Origin in dev (it proxies /api, /ws, /auth). */
const WEB_DEV_PORT = parseInt(process.env.CREWTREE_WEB_DEV_PORT || '5173', 10);
/** Escape hatch for local debugging only; never set by the CLI. */
const AUTH_DISABLED = process.env.CREWTREE_INSECURE_NO_AUTH === '1';
const SESSION_COOKIE = 'crewtree_session';
const WS_HEARTBEAT_MS = 30_000;

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);
const allowedPorts = new Set([String(PORT), ...(isDev ? [String(WEB_DEV_PORT)] : [])]);

function isAllowedHostPort(hostname: string, port: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) && allowedPorts.has(port);
}

function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return isAllowedHostPort(url.hostname, url.port || '80');
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && isAllowedHostPort(url.hostname, url.port || '80');
  } catch {
    return false;
  }
}

/** Non-sensitive UI settings the page needs before React renders (no flash of wrong language/theme, PLAN.md 11.1). */
export function getBootSettings() {
  const { ui } = getAppSettings();
  return { language: ui.language, theme: ui.theme };
}

export function injectBoot(html: string): string {
  const boot = getBootSettings();
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return html
    .replace(/<html lang="[^"]*">/, `<html lang="${boot.language}">`)
    .replace('<head>', `<head>\n    <script>window.__BOOT__ = ${json};</script>`);
}

export async function createServer() {
  ensureDirectories();
  const db = getDb();
  const sessionService = SessionService.getInstance();
  const eventBus = EventBus.getInstance();

  const fastify = Fastify({
    logger: isDev ? { level: 'info' } : { level: 'warn' },
  });

  await fastify.register(fastifyCookie, {
    secret: getSessionSecret(),
    parseOptions: {},
  });

  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      // No CORS headers for foreign origins; the onRequest hook answers them with 403
      cb(null, !origin || isAllowedOrigin(origin));
    },
    credentials: true,
  });

  await fastify.register(fastifyWebsocket);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const webDistPath = path.resolve(__dirname, '../../web/dist');

  if (fs.existsSync(webDistPath)) {
    const indexHtml = fs.readFileSync(path.join(webDistPath, 'index.html'), 'utf8');
    const sendIndex = (reply: any) => reply.type('text/html').send(injectBoot(indexHtml));

    await fastify.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      index: false,
    });

    fastify.get('/', (_req, reply) => sendIndex(reply));
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        reply.code(404).send({ error: 'Route not found' });
      } else {
        sendIndex(reply);
      }
    });
  }

  // Local access security (PLAN.md 15.3): Host (DNS rebinding), Origin (CSRF / foreign pages), session cookie.
  fastify.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHostHeader(req.headers.host)) {
      return reply.code(403).send({ error: 'Invalid Host header' });
    }

    const isWs = req.url.startsWith('/ws');
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const origin = req.headers.origin;
    if ((isMutation || isWs) && origin && !isAllowedOrigin(origin)) {
      return reply.code(403).send({ error: 'Invalid Origin header' });
    }

    const isPublic =
      req.url.startsWith('/api/health') ||
      req.url.startsWith('/api/version') ||
      req.url.startsWith('/api/boot') ||
      req.url.startsWith('/api/shutdown');
    if ((req.url.startsWith('/api') || isWs) && !isPublic && !AUTH_DISABLED) {
      if (!verifySessionCookie(req.cookies[SESSION_COOKIE])) {
        return reply.code(401).send({ error: 'Unauthorized: run `crewtree` to open the web UI again' });
      }
    }
  });

  // /auth?t=<one_time_token> exchanges a one-time token for the session cookie
  fastify.get('/auth', async (req, reply) => {
    const { t } = req.query as { t?: string };
    if (!t || !verifyAndConsumeOneTimeToken(t)) {
      reply.code(400).send('Invalid or expired authentication token. Please launch Crewtree from terminal.');
      return;
    }

    reply.setCookie(SESSION_COOKIE, createSessionCookie(), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: false, // local 127.0.0.1
    });

    reply.redirect('/');
  });

  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      uptime: process.uptime(),
      pid: process.pid,
      runningAgents: sessionService.getRunningProcessCount(),
    };
  });

  fastify.get('/api/version', async () => {
    return {
      current: '0.1.0',
      latest: '0.1.0',
      updateAvailable: false,
      releaseUrl: 'https://github.com/crewtree/crewtree/releases',
    };
  });

  // Settings → Limits "Clean up now"
  fastify.post('/api/settings/cleanup', async () => ({ deleted: cleanupEvents() }));

  // Settings → Account (UI-WIREFRAMES 13)
  fastify.get('/api/account', async () => ({
    dataDir: getCrewtreeDir(),
    claudeDir: getClaudeDir(),
    server: `http://${HOST}:${PORT}`,
    version: '0.1.0',
    claude: await ClaudeStatusService.getInstance().getStatus(),
    throttled: sessionService.hasThrottledAgent(),
  }));

  // Public: only language/theme, used by the Vite dev plugin to inject __BOOT__
  fastify.get('/api/boot', async () => getBootSettings());

  fastify.get('/api/settings', async () => getAppSettings());

  fastify.patch('/api/settings', async (req, reply) => {
    const parsed = AppSettingsSchema.safeParse(deepMerge(getAppSettings(), req.body ?? {}));
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid settings', issues: parsed.error.issues });
      return;
    }
    const value = JSON.stringify(parsed.data);
    db.insert(appSettingsTable)
      .values({ key: 'global', value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: Date.now() } })
      .run();
    return parsed.data;
  });

  registerOrchestrationRoutes(fastify);
  registerResourceRoutes(fastify);
  registerFileRoutes(fastify);
  registerGenerateRoutes(fastify);
  registerTryItRoutes(fastify);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    stopCleanup();
    await sessionService.disposeAll();
    await TryItService.getInstance().disposeAll();
    await ResourceWatcher.getInstance().stop();
    await fastify.close();
    closeDb();
  };
  fastify.decorate('crewtreeShutdown', shutdown);

  // /api/shutdown: CLI only, authenticated with ~/.crewtree/shutdown.token instead of the cookie
  fastify.post('/api/shutdown', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string };
    const shutdownTokenPath = getShutdownTokenPath();
    if (!fs.existsSync(shutdownTokenPath)) {
      reply.code(400).send({ error: 'Shutdown token not found' });
      return;
    }
    const expected = Buffer.from(fs.readFileSync(shutdownTokenPath, 'utf8').trim());
    const actual = Buffer.from(token ?? '');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }

    reply.send({ status: 'shutting down' });
    setTimeout(() => {
      void shutdown().finally(() => process.exit(0));
    }, 100);
  });

  // Heartbeat: terminate sockets that stop answering pings (PLAN.md 17)
  const alive = new WeakMap<object, boolean>();
  const sockets = new Set<any>();
  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, WS_HEARTBEAT_MS);
  heartbeat.unref();

  fastify.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = url.searchParams.get('sessionId') || undefined;

    const replay = (sid: string, lastEventIdStr: string | null | undefined) => {
      const lastEventId = parseInt(lastEventIdStr ?? '', 10);
      if (isNaN(lastEventId)) return;
      for (const evt of eventBus.getEventsAfter(sid, lastEventId)) {
        socket.send(JSON.stringify(evt));
      }
    };

    sockets.add(socket);
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('close', () => sockets.delete(socket));

    socket.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    // Replay before registering; both are synchronous so no live event can slip in between.
    if (sessionId) replay(sessionId, url.searchParams.get('lastEventId'));
    eventBus.registerClient(socket, sessionId);

    socket.on('message', (msg: any) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (data.type === 'subscribe' && typeof data.sessionId === 'string') {
          if (data.lastEventId !== undefined) replay(data.sessionId, String(data.lastEventId));
          eventBus.updateClientSession(socket, data.sessionId);
        }
      } catch {
        // ignore parse error
      }
    });
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

  const onSignal = () => {
    void (app as any).crewtreeShutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🌲 Crewtree Server running on http://${HOST}:${PORT}`);
    console.log(`🔑 Login: http://${HOST}:${PORT}/auth?t=${generateOneTimeToken()}`);
    if (isDev) {
      console.log(`🔑 Login (Vite dev): http://localhost:${WEB_DEV_PORT}/auth?t=${generateOneTimeToken()}`);
    }
    console.log('   (one-time links, valid for 60s)\n');
    // Resources follow CLI/editor edits; the watcher moves with the project switcher (PLAN.md 6.1)
    ResourceWatcher.getInstance().start();
    ProjectService.getInstance().onChange(() => ResourceWatcher.getInstance().start());
    // Event log retention of closed sessions (Settings → Limits)
    scheduleCleanup();
    // Default Supervisor when the library has none (PLAN.md 4.1); not blocking startup
    void ensureDefaultSupervisor(getCurrentProjectPath()).catch((err) =>
      console.warn('[crewtree] Could not create the default supervisor:', err)
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  start();
}
