// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import open from 'open';
import { DEFAULT_PORT } from '@crewtree/shared';
import { bundleRoot, files, serverEntry } from './layout.js';
import { ensureNative } from './native.js';
import { CliError } from './ui.js';

export interface Health {
  status: string;
  version: string;
  port: number;
  pid: number;
  uptime: number;
  runningAgents: number;
}

export function readConfig(): { port: number; pid?: number; version?: string; startedAt?: number } {
  try {
    return JSON.parse(fs.readFileSync(files.config(), 'utf8'));
  } catch {
    return { port: DEFAULT_PORT };
  }
}

function readToken(): string | undefined {
  try {
    return fs.readFileSync(files.token(), 'utf8').trim();
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function readPid(): number | undefined {
  try {
    return Number(fs.readFileSync(files.pid(), 'utf8').trim()) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Running = /api/health answers on the configured port AND its pid is the one in this data folder's pid
 * file (PLAN.md 16.3). Another Crewtree on that port (other data folder, a dev server) is not ours: the CLI
 * never talks to it, stops it or kills it.
 */
export async function health(timeoutMs = 2000): Promise<Health | null> {
  const { port } = readConfig();
  const pid = readPid();
  if (!pid) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as Health;
    return data.status === 'ok' && data.pid === pid ? data : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the server as a background process; logs go to ~/.crewtree/logs/server.log. */
export async function startServer(opts: { project?: string; root?: string } = {}): Promise<Health> {
  const entry = serverEntry(opts.root);
  if (!fs.existsSync(entry))
    throw new CliError(`Server not found at ${entry}`, 'Reinstall Crewtree or run `pnpm build` in a checkout.');
  ensureNative(opts.root ?? bundleRoot());
  fs.mkdirSync(files.logs(), { recursive: true });
  const log = fs.openSync(files.serverLog(), 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(path.dirname(entry)),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ...(opts.project ? { CREWTREE_PROJECT: opts.project } : {}),
    },
  });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (child.exitCode !== null) break;
    const h = await health(1000);
    if (h && h.pid === child.pid) return h;
  }
  throw new CliError('The server did not start', `See the log: ${files.serverLog()}`);
}

export async function stopServer(timeoutMs = 15_000): Promise<boolean> {
  const h = await health();
  if (!h) return false;
  const pid = h.pid;
  const token = readToken();
  if (!token)
    throw new CliError(
      'The shutdown token is missing',
      `Stop the process yourself (pid ${pid}) or restart it with crewtree.`
    );
  {
    try {
      await fetch(`http://127.0.0.1:${h.port}/api/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // the server may close the socket while answering
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(200);
  }
  // Last resort when shutdown did not finish: only our own server (pid checked by health above)
  if (pidAlive(pid) && readPid() === pid) process.kill(pid);
  return true;
}

/** Opens the web UI signed in (one-time link), switching the project when given. */
export async function openBrowser(project?: string, noOpen = false): Promise<string> {
  const h = await health();
  const token = readToken();
  if (!h || !token) throw new CliError('The server is not running');
  const res = await fetch(`http://127.0.0.1:${h.port}/api/cli/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, project }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new CliError(body.error ?? `Could not open the UI (${res.status})`);
  if (!noOpen) await open(body.url);
  return body.url;
}

/**
 * `crewtree serve`: runs the server in the foreground for launchd / systemd / Task Scheduler (PLAN.md 16.3),
 * so they see it exit. Returns the server's exit code; 0 right away when it is already running.
 */
export async function serveForeground(): Promise<number> {
  if (await health()) return 0;
  const entry = serverEntry();
  if (!fs.existsSync(entry)) throw new CliError(`Server not found at ${entry}`);
  ensureNative(bundleRoot());
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(path.dirname(entry)),
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}

export { bundleRoot };
