// SPDX-License-Identifier: Apache-2.0
import readline from 'readline';

/** CLI output is English only (PLAN.md 11.1); colours only on a TTY without NO_COLOR. */
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  green: wrap(32),
  red: wrap(31),
  yellow: wrap(33),
  cyan: wrap(36),
  dim: wrap(2),
  bold: wrap(1),
};

export const ok = (msg: string) => console.log(`${c.green('✓')} ${msg}`);
export const fail = (msg: string) => console.log(`${c.red('✕')} ${msg}`);
export const warn = (msg: string) => console.log(`${c.yellow('!')} ${msg}`);
export const info = (msg: string) => console.log(`  ${msg}`);

export function step(n: number, total: number, label: string) {
  process.stdout.write(`  [${n}/${total}] ${label.padEnd(30)} `);
}

export function progress(done: number, total: number) {
  if (!process.stdout.isTTY || !total) return;
  const width = 24;
  const filled = Math.round((done / total) * width);
  process.stdout.write(
    `\r${' '.repeat(40)}${'#'.repeat(filled)}${'.'.repeat(width - filled)} ${Math.round((done / total) * 100)}%`
  );
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export class CliError extends Error {
  constructor(
    message: string,
    public hint?: string
  ) {
    super(message);
  }
}
