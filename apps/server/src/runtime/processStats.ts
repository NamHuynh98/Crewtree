// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

interface Proc {
  pid: number;
  ppid: number;
  rssBytes: number;
}

async function listProcesses(): Promise<Proc[]> {
  if (process.platform === 'win32') {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress',
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 10_000 }
    );
    const rows = JSON.parse(stdout || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      rssBytes: Number(r.WorkingSetSize) || 0,
    }));
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss='], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length === 3 && parts.every((n) => Number.isFinite(n)))
    .map(([pid, ppid, rssKb]) => ({ pid, ppid, rssBytes: rssKb * 1024 }));
}

let cache: { at: number; value: Promise<{ count: number; rssBytes: number } | null> } | null = null;
/** Listing processes is slow on Windows (PowerShell): share one result for a few seconds. */
const CACHE_MS = 4000;

/**
 * Memory of the Claude Code processes Crewtree started: every descendant of this server process
 * (PLAN.md 21, Session settings "Processes … RAM"). Best effort; null when the OS query fails.
 */
export function childProcessStats(): Promise<{ count: number; rssBytes: number } | null> {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), value: computeStats() };
  return cache.value;
}

async function computeStats(): Promise<{ count: number; rssBytes: number } | null> {
  try {
    const procs = await listProcesses();
    const children = new Map<number, Proc[]>();
    for (const p of procs) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid)!.push(p);
    }
    let count = 0;
    let rssBytes = 0;
    const stack = [...(children.get(process.pid) ?? [])];
    const seen = new Set<number>();
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      count++;
      rssBytes += p.rssBytes;
      stack.push(...(children.get(p.pid) ?? []));
    }
    return { count, rssBytes };
  } catch {
    return null;
  }
}
