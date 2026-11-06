// SPDX-License-Identifier: Apache-2.0
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './db/index.js';
import { acquireInstanceLock, releaseInstanceLock } from './instanceLock.js';
import { appSettingsTable } from './db/schema.js';
import { ensureDirectories, getClaudeDir, getConfigPath, getCrewtreeDir, getShutdownTokenPath } from './paths.js';
import { cleanupEvents, scheduleCleanup, stopCleanup } from './settings/maintenance.js';
import { ClaudeStatusService } from './claude/ClaudeStatusService.js';
import {
  generateOneTimeToken,
  verifyAndConsumeOneTimeToken,
  createSessionCookie,
  verifySessionCookie,
  getSessionSecret,
  SESSION_MAX_AGE_MS,
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
import net from 'net';
import crypto from 'crypto';
import { checkForUpdate, currentVersion, updateChecksDisabled } from './version.js';

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
/** The port the server listens on: PORT, else the last one used, else the next free one (PLAN.md 16.3). */
let activePort = PORT;

function setActivePort(port: number) {
  allowedPorts.delete(String(activePort));
  activePort = port;
  allowedPorts.add(String(port));
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

/** Preferred port first, then the next 20, then any port the OS gives. */
async function choosePort(preferred: number): Promise<number> {
  // A restarting server (tsx watch, autostart, `crewtree restart`) may still hold the port for a moment
  for (let i = 0; i < 10; i++) {
    if (await portIsFree(preferred)) return preferred;
    await new Promise((r) => setTimeout(r, 300));
  }
  for (let p = preferred + 1; p < preferred + 20; p++) if (await portIsFree(p)) return p;
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function verifyCliToken(token: string | undefined): boolean {
  const file = getShutdownTokenPath();
  if (!fs.existsSync(file)) return false;
  const expected = Buffer.from(fs.readFileSync(file, 'utf8').trim());
  const actual = Buffer.from(token ?? '');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

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
    // no-cache: after an update the page must name the new hashed assets
    const sendIndex = (reply: any) =>
      reply.type('text/html').header('Cache-Control', 'no-cache').send(injectBoot(indexHtml));

    await fastify.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      index: false,
      // Built JS/CSS under /assets/ have a content hash in their name: cache them for good, so a reload only
      // asks for index.html. Other files (icons, manifest) are revalidated as before.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0');
      },
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
    const isApi = req.url.startsWith('/api') || isWs;
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const origin = req.headers.origin;
    // Any method: a foreign page must not even trigger API reads (the SameSite=Strict cookie is the second layer)
    if ((isMutation || isApi) && origin && !isAllowedOrigin(origin)) {
      return reply.code(403).send({ error: 'Invalid Origin header' });
    }
    if (isApi && req.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'Cross-site request' });
    }

    const isPublic =
      req.url.startsWith('/api/health') ||
      req.url.startsWith('/api/version') ||
      req.url.startsWith('/api/boot') ||
      req.url.startsWith('/api/shutdown') ||
      req.url.startsWith('/api/cli/');
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

    // Kept across browser restarts so the installed app (PWA) opened from the Dock / Start menu stays signed in
    reply.setCookie(SESSION_COOKIE, createSessionCookie(), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: false, // local 127.0.0.1
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });

    reply.redirect('/');
  });

  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      version: currentVersion(),
      port: activePort,
      uptime: process.uptime(),
      pid: process.pid,
      runningAgents: sessionService.getRunningProcessCount(),
    };
  });

  // Update notice for the web banner (PLAN.md 16.4); at most one GitHub call a day
  fastify.get('/api/version', async () => {
    const check = await checkForUpdate();
    return {
      current: check.current,
      latest: check.latest ?? check.current,
      updateAvailable: check.updateAvailable,
      releaseUrl: check.releaseUrl,
      disabled: updateChecksDisabled(),
    };
  });

  // CLI: `crewtree [path]` opens the browser signed in, switching the project (PLAN.md 16.3).
  // Authenticated with ~/.crewtree/shutdown.token, which only the local user can read.
  fastify.post('/api/cli/open', async (req, reply) => {
    const { token, project } = (req.body ?? {}) as { token?: string; project?: string };
    if (!verifyCliToken(token)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    try {
      if (project) ProjectService.getInstance().open(project);
    } catch (err: any) {
      reply.code(400).send({ error: err.message });
      return;
    }
    return {
      url: `http://${HOST}:${activePort}/auth?t=${generateOneTimeToken()}`,
      openIn: getAppSettings().launch.openIn,
    };
  });

  // Settings → Limits "Clean up now"
  fastify.post('/api/settings/cleanup', async () => ({ deleted: cleanupEvents() }));

  // Settings → Account (UI-WIREFRAMES 13)
  fastify.get('/api/account', async () => ({
    dataDir: getCrewtreeDir(),
    claudeDir: getClaudeDir(),
    server: `http://${HOST}:${activePort}`,
    version: currentVersion(),
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
    // The CLI treats a missing pid file as "not running"
    fs.rmSync(getShutdownTokenPath(), { force: true });
    releaseInstanceLock();
  };
  fastify.decorate('crewtreeShutdown', shutdown);

  // /api/shutdown: CLI only, authenticated with ~/.crewtree/shutdown.token instead of the cookie
  fastify.post('/api/shutdown', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string };
    if (!verifyCliToken(token)) {
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
  // One server per data folder, taken before the database is opened (migrations included)
  const lock = await acquireInstanceLock();
  if (!lock.acquired) {
    console.log(`Crewtree is already running on this data folder (pid ${lock.pid})`);
    process.exit(0);
  }
  let app: Awaited<ReturnType<typeof createServer>>;
  try {
    app = await createServer();
  } catch (err) {
    releaseInstanceLock();
    throw err;
  }

  // The pid file is the lock (written above); the shutdown token next to it
  const shutdownToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(getShutdownTokenPath(), shutdownToken, { mode: 0o600, encoding: 'utf8' });

  // Same port as last time unless PORT is set; another free one when it is taken.
  // Dev always aims at PORT: the Vite proxy targets it.
  let preferred = PORT;
  if (!process.env.PORT && !isDev) {
    try {
      preferred = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')).port || PORT;
    } catch {
      preferred = PORT;
    }
  }
  setActivePort(await choosePort(preferred));
  // config.json tells the CLI where the server is (PLAN.md 16.3)
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({ port: activePort, pid: process.pid, version: currentVersion(), startedAt: Date.now() }),
    'utf8'
  );

  const onSignal = () => {
    void (app as any).crewtreeShutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await app.listen({ port: activePort, host: HOST });
    console.log(`\n🌲 Crewtree ${currentVersion()} running on http://${HOST}:${activePort}`);
    console.log(`🔑 Login: http://${HOST}:${activePort}/auth?t=${generateOneTimeToken()}`);
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
    releaseInstanceLock();
    fs.rmSync(getShutdownTokenPath(), { force: true });
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  start();
}
