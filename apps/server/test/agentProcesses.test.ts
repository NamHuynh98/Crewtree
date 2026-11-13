// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { reapOrphanedAgentProcesses, stopAgentsOf, trackAgentProcess } from '../src/runtime/agentProcesses.js';
import { getAgentProcessesDir } from '../src/paths.js';
import { waitFor } from './helpers/tree.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const listOf = (serverPid: number) => path.join(getAgentProcessesDir(), `${serverPid}.json`);

/**
 * Stands in for a `claude` agent with a `run_in_background` command: Claude Code starts background shells
 * in their own process group, so stopping the agent's process alone would leave them running.
 */
const FAKE_AGENT = `
const { spawn } = require('child_process');
const shell = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
console.log(JSON.stringify({ shell: shell.pid }));
setInterval(() => {}, 1000);
`;

async function groupGone(pgid: number) {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pgid=,command=']);
  return !stdout.split('\n').some((l) => l.trim().startsWith(`${pgid} `));
}

describe.skipIf(process.platform === 'win32')('agent processes of a server that is gone', () => {
  it('stops the recorded agent, its children and the process groups they lead', async () => {
    const agent = spawn(process.execPath, ['-e', FAKE_AGENT], { stdio: ['pipe', 'pipe', 'pipe'] });
    trackAgentProcess(agent, process.execPath, 'agent-1');
    const { shell } = await new Promise<{ shell: number }>((resolve) =>
      agent.stdout!.once('data', (d) => resolve(JSON.parse(String(d))))
    );
    await waitFor(() => alive(shell), 2000, 'background shell running');
    const recorded = JSON.parse(fs.readFileSync(listOf(process.pid), 'utf8'));
    expect(recorded).toMatchObject([{ pid: agent.pid, command: process.execPath, sessionAgentId: 'agent-1' }]);

    expect(await stopAgentsOf(process.pid)).toBeGreaterThanOrEqual(2);
    await waitFor(() => !alive(agent.pid!) && !alive(shell), 5000, 'all stopped');
    expect(await groupGone(shell)).toBe(true); // `sleep` inside the shell's group went with it
    expect(fs.existsSync(listOf(process.pid))).toBe(false);
  });

  it('leaves a process alone once its pid belongs to another program', async () => {
    const other = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    fs.mkdirSync(getAgentProcessesDir(), { recursive: true });
    // A dead server recorded the claude binary under this pid; it now runs something else
    fs.writeFileSync(
      listOf(999_999),
      JSON.stringify([{ pid: other.pid, command: '/opt/claude/bin/claude', sessionAgentId: 'x', startedAt: 0 }])
    );
    expect(await reapOrphanedAgentProcesses({ assumeDead: true })).toBe(0);
    expect(alive(other.pid!)).toBe(true);
    expect(fs.existsSync(listOf(999_999))).toBe(false);
    other.kill('SIGKILL');
  });

  it('forgets a process once it exits normally', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' });
    trackAgentProcess(child, process.execPath, 'agent-2');
    expect(fs.existsSync(listOf(process.pid))).toBe(true);
    await new Promise((r) => child.once('exit', r));
    expect(fs.existsSync(listOf(process.pid))).toBe(false);
  });

  it('the watchdog stops the agents as soon as the server is killed, without a new server', async () => {
    const server = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'fixtures', 'fakeServer.ts')], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    });
    const pids = await new Promise<{ server: number; agent: number; shell: number; watchdog: number }>(
      (resolve, reject) => {
        server.stdout!.once('data', (d) => resolve(JSON.parse(String(d))));
        server.once('exit', (code) => reject(new Error(`fake server exited (${code})`)));
      }
    );
    await waitFor(() => alive(pids.watchdog) && alive(pids.shell), 3000, 'watchdog and shell running');

    // The CLI (no lock) leaves a running server's agents alone
    expect(await reapOrphanedAgentProcesses()).toBe(0);
    expect(alive(pids.agent)).toBe(true);

    const killedAt = Date.now();
    server.kill('SIGKILL');
    await waitFor(() => !alive(pids.agent) && !alive(pids.shell), 5000, 'agents stopped by the watchdog');
    expect(Date.now() - killedAt).toBeLessThan(2000);
    expect(await groupGone(pids.shell)).toBe(true);
    await waitFor(() => !alive(pids.watchdog), 3000, 'watchdog exited');
    expect(fs.existsSync(listOf(pids.server))).toBe(false);
  });
});
