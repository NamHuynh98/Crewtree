// SPDX-License-Identifier: Apache-2.0
/**
 * One server per data folder (~/.crewtree). Two starts at the same moment happen: autostart at login while the
 * user types `crewtree`, two terminals, launchd plus a manual start. Without a lock the second server overwrote
 * the pid file and the shutdown token, failed on the port and exited, and the CLI lost the running one.
 *
 * The pid file is the lock: created exclusively before the database is opened, removed at shutdown. A pid file
 * left by a crash (kill -9, power loss) is taken over once its process is gone.
 */
import fs from 'fs';
import { getConfigPath, getPidPath } from './paths.js';

const WAIT_FOR_OTHER_MS = 15_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function readPid(): number {
  try {
    return Number(fs.readFileSync(getPidPath(), 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

/** The other server answers on the port it wrote to config.json, as that pid */
async function answers(pid: number): Promise<boolean> {
  try {
    const { port } = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { pid?: number };
    return res.ok && body.pid === pid;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `acquired`, or the pid of the Crewtree server that already runs on this data folder. */
export async function acquireInstanceLock(): Promise<{ acquired: true } | { acquired: false; pid: number }> {
  const file = getPidPath();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, `${process.pid}`);
      fs.closeSync(fd);
      return { acquired: true };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const pid = readPid();
    // Empty: another server is writing its pid this very moment (or crashed right then: removed next time)
    if (!pid && attempt === 0) {
      await sleep(200);
      continue;
    }
    if (pid && pid !== process.pid && alive(pid)) {
      // Starting (no port yet) or running: wait for it to answer, or to die
      for (const deadline = Date.now() + WAIT_FOR_OTHER_MS; Date.now() < deadline && alive(pid);) {
        if (await answers(pid)) return { acquired: false, pid };
        await sleep(250);
      }
      if (alive(pid) && (await answers(pid))) return { acquired: false, pid };
      // Still alive but never answered: the pid was reused by an unrelated process after a crash
    }
    // Stale: remove it only if nobody took the lock meanwhile
    if (readPid() === pid) fs.rmSync(file, { force: true });
    else await sleep(100);
  }
  throw new Error(`Could not lock ${file}`);
}

/** Lets the next server start: only when the pid file is still ours. */
export function releaseInstanceLock(): void {
  if (readPid() === process.pid) fs.rmSync(getPidPath(), { force: true });
}
