// SPDX-License-Identifier: Apache-2.0
/**
 * Agent processes outliving a crashed server (found in a real `kill -9` run).
 *
 * Each agent is a `claude` child process. When the server dies without shutting down, the children keep
 * running: the one in the test finished its turn's tool calls for several seconds, and the background shells
 * it had started (`run_in_background`, each in its own process group) kept running too. Task fencing
 * stops their stale *state* from reaching the database, but not their side effects (files, commands).
 *
 * Every agent process is recorded in `agent-processes/<server pid>.json` while it runs. What is left of a
 * server that died is stopped by, in order:
 * 1. its watchdog (watchdog.ts), the moment the server's pipe closes — within a second of the crash;
 * 2. the next server, before it reconciles the database — when the watchdog died too;
 * 3. the CLI (`crewtree status` / `stop` / `open`) when it finds the server dead.
 * Stopping means the recorded process, every process below it, and the process groups those lead (a
 * background shell and its commands). One file per server: a late watchdog never touches the next server's agents.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { writeFileAtomic } from '../lib/atomicWrite.js';
import { getAgentProcessesDir } from '../paths.js';

const run = promisify(execFile);
const isWindows = process.platform === 'win32';
const GRACE_MS = 3_000;

interface Entry {
  pid: number;
  /** Executable, to tell our process from an unrelated one that got the same pid after a crash */
  command: string;
  sessionAgentId: string;
  startedAt: number;
}

const fileOf = (serverPid: number) => path.join(getAgentProcessesDir(), `${serverPid}.json`);

function readEntries(file: string): Entry[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.filter((e) => Number.isInteger(e?.pid) && typeof e?.command === 'string') : [];
  } catch {
    return [];
  }
}

function writeEntries(file: string, entries: Entry[]) {
  try {
    if (entries.length) writeFileAtomic(file, JSON.stringify(entries, null, 2));
    else fs.rmSync(file, { force: true });
  } catch (err: any) {
    console.warn('[agentProcesses] Could not update the process list:', err?.message ?? err);
  }
}

/** Records a running agent process of this server until it exits. */
export function trackAgentProcess(child: ChildProcess, command: string, sessionAgentId: string): void {
  const pid = child.pid;
  if (!pid) return;
  const file = fileOf(process.pid);
  writeEntries(file, [
    ...readEntries(file).filter((e) => e.pid !== pid),
    { pid, command, sessionAgentId, startedAt: Date.now() },
  ]);
  child.once('exit', () =>
    writeEntries(
      file,
      readEntries(file).filter((e) => e.pid !== pid)
    )
  );
}

/** `spawnClaudeCodeProcess` for the Agent SDK: its default local spawn, plus tracking. */
export function spawnTrackedClaude(sessionAgentId: string) {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // The SDK reads stderr only from its own spawn; drain it so a chatty child never blocks on a full pipe
    child.stderr?.resume();
    child.on('error', () => undefined); // reported by the SDK through stdout/exit; never an uncaught error here
    trackAgentProcess(child, options.command, sessionAgentId);
    return child as SpawnedProcess; // stdio is all pipes, so stdin/stdout are set
  };
}

// ---------------------------------------------------------------- stopping

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

async function processTable(): Promise<Map<number, Row>> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { maxBuffer: 32 * 1024 * 1024 });
  const rows = new Map<number, Row>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
  }
  return rows;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function signal(target: number, sig: NodeJS.Signals) {
  try {
    process.kill(target, sig);
  } catch {
    // already gone
  }
}

/** The process still runs the executable we started (an absolute path from the SDK, or a bare `claude`). */
const sameExecutable = (commandLine: string, executable: string) =>
  commandLine === executable || commandLine.startsWith(`${executable} `);

/** POSIX: the recorded process, everything below it, and the process groups those lead. */
async function stopPosix(entries: Entry[]): Promise<number> {
  const table = await processTable();
  const children = new Map<number, number[]>();
  for (const row of table.values()) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);

  const pids = new Set<number>();
  const groups = new Set<number>();
  for (const entry of entries) {
    const row = table.get(entry.pid);
    if (!row || !sameExecutable(row.command, entry.command)) continue; // gone, or the pid now belongs to someone else
    const queue = [entry.pid];
    while (queue.length) {
      const pid = queue.shift()!;
      if (pids.has(pid) || pid === process.pid) continue;
      pids.add(pid);
      // A process leading its own group (a background shell) takes its commands along. The agent's own
      // group is the old server's (often the user's terminal job), so it is never signalled as a group.
      if (pid !== entry.pid && table.get(pid)?.pgid === pid) groups.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
  }
  if (!pids.size) return 0;

  const stop = (sig: NodeJS.Signals) => {
    for (const pgid of groups) signal(-pgid, sig);
    for (const pid of pids) signal(pid, sig);
  };
  stop('SIGTERM');
  for (const deadline = Date.now() + GRACE_MS; Date.now() < deadline && [...pids].some(processAlive);) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if ([...pids].some(processAlive)) stop('SIGKILL');
  return pids.size;
}

/** Windows: `taskkill /T` stops the process tree. */
async function stopWindows(entries: Entry[]): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    try {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${entry.pid}`, '/FO', 'CSV', '/NH']);
      const image = path.win32.basename(entry.command).toLowerCase();
      if (!stdout.toLowerCase().includes(`"${image}"`)) continue;
      await run('taskkill', ['/PID', String(entry.pid), '/T', '/F']);
      count++;
    } catch {
      // gone meanwhile, or not ours to stop
    }
  }
  return count;
}

/** Stops the recorded agent processes of a server that is gone, then forgets them. */
export async function stopAgentsOf(serverPid: number): Promise<number> {
  const file = fileOf(serverPid);
  const entries = readEntries(file);
  let count = 0;
  if (entries.length) {
    try {
      count = isWindows ? await stopWindows(entries) : await stopPosix(entries);
    } catch (err: any) {
      console.warn('[agentProcesses] Could not stop leftover agent processes:', err?.message ?? err);
      return 0; // keep the file: the next server or CLI run tries again
    }
  }
  fs.rmSync(file, { force: true });
  return count;
}

function recordedServers(): number[] {
  try {
    return fs
      .readdirSync(getAgentProcessesDir())
      .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
      .filter((p): p is string => !!p)
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * Stops what servers that are gone left behind. The server calls it holding the instance lock, so every
 * other server's list is stale (`assumeDead`). The CLI calls it without the lock and only touches the lists of
 * servers whose process is gone.
 */
export async function reapOrphanedAgentProcesses(opts: { assumeDead?: boolean } = {}): Promise<number> {
  let count = 0;
  for (const serverPid of recordedServers()) {
    if (serverPid === process.pid) continue;
    if (!opts.assumeDead && processAlive(serverPid)) continue;
    count += await stopAgentsOf(serverPid);
  }
  if (count) console.log(`Stopped ${count} agent process(es) left by a previous Crewtree server`);
  return count;
}

// ---------------------------------------------------------------- watchdog

/** watchdog.ts next to this module: `.ts` under tsx (dev, tests), `.js` in the build. */
export function watchdogPath(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `watchdog${path.extname(self)}`);
}

/**
 * Starts this server's watchdog: a small detached process holding the read end of a pipe from the server.
 * However the server ends (crash, `kill -9`, power cut aside), the OS closes the pipe and the watchdog stops
 * the server's agents at once instead of when the next server starts.
 */
export function startWatchdog(): ChildProcess | undefined {
  try {
    const child = spawn(process.execPath, [...process.execArgv, watchdogPath(), '--server', String(process.pid)], {
      stdio: ['pipe', 'inherit', 'inherit'],
      detached: true, // own session: Ctrl+C on the server's terminal job does not take it down first
      windowsHide: true,
      env: process.env,
    });
    child.on('error', (err) => console.warn('[agentProcesses] Watchdog failed:', err.message));
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    return child;
  } catch (err: any) {
    console.warn('[agentProcesses] Could not start the watchdog:', err?.message ?? err);
    return undefined;
  }
}
