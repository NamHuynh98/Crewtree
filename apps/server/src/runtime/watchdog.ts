// SPDX-License-Identifier: Apache-2.0
/**
 * Stops a dead server's agent processes (agentProcesses.ts). Kept free of the server's heavy modules: it
 * runs as its own small process.
 *
 *   watchdog --server <pid>   started by the server with a pipe on stdin. When the pipe closes (the server
 *                             exited or was killed) or the pid is gone, stops that server's agents and exits.
 *   watchdog --reap           for the CLI: stops what dead servers left, then exits.
 */
import { processAlive, reapOrphanedAgentProcesses, stopAgentsOf } from './agentProcesses.js';

const POLL_MS = 2_000;

async function watch(serverPid: number) {
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    const count = await stopAgentsOf(serverPid);
    if (count) console.log(`[watchdog] Server ${serverPid} is gone: stopped ${count} agent process(es)`);
    process.exit(0);
  };
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.stdin.on('error', finish);
  process.stdin.resume(); // nothing is sent; only the pipe closing matters
  // Backup for a pipe kept open by mistake (inherited by another process)
  setInterval(() => {
    if (!processAlive(serverPid)) void finish();
  }, POLL_MS);
  // Terminal signals are for the server; this process leaves when the server is gone (or on SIGTERM/SIGKILL)
  for (const sig of ['SIGINT', 'SIGHUP'] as const) process.on(sig, () => undefined);
}

const args = process.argv.slice(2);
if (args[0] === '--server' && Number(args[1]) > 0) {
  void watch(Number(args[1]));
} else if (args[0] === '--reap') {
  void reapOrphanedAgentProcesses().then(() => process.exit(0));
} else {
  console.error('Usage: watchdog --server <pid> | --reap');
  process.exit(2);
}
