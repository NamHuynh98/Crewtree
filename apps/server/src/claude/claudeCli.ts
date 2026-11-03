// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'child_process';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<CliResult>;

/** `claude` on PATH, or CREWTREE_CLAUDE_BIN. */
function binary(): string {
  return process.env.CREWTREE_CLAUDE_BIN || 'claude';
}

const defaultRunner: CliRunner = (args, { cwd, timeoutMs = 120_000 }) =>
  new Promise((resolve) => {
    const child = spawn(binary(), args, {
      cwd,
      // claude.cmd on Windows needs a shell; arguments here never come from the browser unquoted
      shell: process.platform === 'win32',
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      stderr += `\nTimed out after ${Math.round(timeoutMs / 1000)}s`;
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

let runner: CliRunner = defaultRunner;

/**
 * Claude Code's own CLI for config it owns (PLAN.md 6.3): `claude mcp …` for ~/.claude.json and
 * `claude plugin …` for plugins, so Crewtree never races Claude Code writing the same files.
 */
export const ClaudeCli = {
  run(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<CliResult> {
    return runner(args, opts);
  },

  /** Runs and throws with the CLI's own message on failure. */
  async exec(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<string> {
    const res = await runner(args, opts);
    if (res.code !== 0) {
      const message = (res.stderr || res.stdout).trim().split('\n').slice(-4).join('\n');
      throw new Error(message || `claude ${args[0]} ${args[1] ?? ''} failed (${res.code})`);
    }
    return res.stdout;
  },

  /** Tests replace the CLI. */
  setRunner(next?: CliRunner) {
    runner = next ?? defaultRunner;
  },
};
