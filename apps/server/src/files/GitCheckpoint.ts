// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export interface Checkpoint {
  ref: string;
  commit: string;
  n: number;
}

/**
 * Optional git checkpoints (PLAN.md 5.4): before each Supervisor turn, snapshot the working tree into
 * `refs/crewtree/checkpoints/<session>/<n>` from a temporary index. Never changes the branch, the user's
 * index, the working tree or the commit history.
 */
export class GitCheckpoint {
  public static async isRepo(cwd: string): Promise<boolean> {
    try {
      return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
    } catch {
      return false;
    }
  }

  public static refPrefix(sessionId: string): string {
    return `refs/crewtree/checkpoints/${sessionId}`;
  }

  public static async list(cwd: string, sessionId: string): Promise<Checkpoint[]> {
    const out = await git(cwd, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      GitCheckpoint.refPrefix(sessionId),
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, commit] = line.split(' ');
        return { ref, commit, n: Number(ref.split('/').pop()) };
      })
      .sort((a, b) => a.n - b.n);
  }

  public static async create(cwd: string, sessionId: string, label: string): Promise<Checkpoint> {
    const existing = await GitCheckpoint.list(cwd, sessionId);
    const n = (existing.at(-1)?.n ?? 0) + 1;
    const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-index-')), 'index');
    const env = {
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: 'Crewtree',
      GIT_AUTHOR_EMAIL: 'checkpoint@crewtree.local',
      GIT_COMMITTER_NAME: 'Crewtree',
      GIT_COMMITTER_EMAIL: 'checkpoint@crewtree.local',
    };
    try {
      let head: string | undefined;
      try {
        head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
        await git(cwd, ['read-tree', head], env);
      } catch {
        head = undefined; // repository without commits yet
      }
      await git(cwd, ['add', '-A'], env);
      const tree = await git(cwd, ['write-tree'], env);
      const commit = await git(
        cwd,
        ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `crewtree checkpoint ${n}: ${label}`],
        env
      );
      const ref = `${GitCheckpoint.refPrefix(sessionId)}/${n}`;
      await git(cwd, ['update-ref', ref, commit]);
      return { ref, commit, n };
    } finally {
      fs.rmSync(path.dirname(index), { recursive: true, force: true });
    }
  }

  /** Restores tracked content from a checkpoint (after the user confirmed). Files created later are kept. */
  public static async restore(cwd: string, ref: string): Promise<void> {
    await git(cwd, ['restore', `--source=${ref}`, '--worktree', '--', '.']);
  }

  /** Session deleted: drop its checkpoint refs. */
  public static async removeAll(cwd: string, sessionId: string): Promise<void> {
    for (const cp of await GitCheckpoint.list(cwd, sessionId)) await git(cwd, ['update-ref', '-d', cp.ref]);
  }
}
