// SPDX-License-Identifier: Apache-2.0
// A stand-in server for test/agentProcesses.test.ts: one tracked "agent" with a background shell, and the
// real watchdog. Prints the pids, then waits to be killed.
import { spawn } from 'child_process';
import { startWatchdog, trackAgentProcess } from '../../src/runtime/agentProcesses.js';

const FAKE_AGENT = `
const { spawn } = require('child_process');
const shell = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
console.log(JSON.stringify({ shell: shell.pid }));
setInterval(() => {}, 1000);
`;

const agent = spawn(process.execPath, ['-e', FAKE_AGENT], { stdio: ['pipe', 'pipe', 'inherit'] });
trackAgentProcess(agent, process.execPath, 'agent-1');
const watchdog = startWatchdog();
agent.stdout!.once('data', (d) => {
  const { shell } = JSON.parse(String(d));
  console.log(JSON.stringify({ server: process.pid, agent: agent.pid, shell, watchdog: watchdog?.pid }));
});
setInterval(() => {}, 1000);
