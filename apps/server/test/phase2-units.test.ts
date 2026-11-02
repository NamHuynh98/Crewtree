// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { entriesOverlap, isInScope, scopesOverlap } from '../src/files/scope.js';
import { matchesRule, suggestRule, validateRule } from '../src/approvals/permissionPatterns.js';
import { ConcurrencyLimiter } from '../src/runtime/ConcurrencyLimiter.js';
import { FileLockManager } from '../src/files/FileLockManager.js';
import { GitCheckpoint } from '../src/files/GitCheckpoint.js';
import { pickBestModel } from '../src/models/ModelCatalogService.js';
import { ensureDefaultSupervisor } from '../src/resources/agents/defaultSupervisor.js';

describe('task scope (PLAN.md 5)', () => {
  it.each([
    ['src/auth/**', 'src/pages/**', false],
    ['src/auth/**', 'src/auth/login.ts', true],
    ['src/pages/Login*', 'src/pages/Signup*', false],
    ['src/pages/Login*', 'src/pages/Login.tsx', true],
    ['src/auth', 'src/auth/x.ts', true],
    ['src', 'docs', false],
    ['src/*.ts', 'src/a/b.ts', false],
    ['**/*.md', 'docs/a.md', true],
  ])('%s vs %s overlap = %s', (a, b, expected) => {
    expect(entriesOverlap(a, b)).toBe(expected);
    expect(entriesOverlap(b, a)).toBe(expected);
  });

  it('checks paths against globs and directories', () => {
    expect(isInScope('src/auth/a.ts', ['src/auth/**'])).toBe(true);
    expect(isInScope('src/auth/a.ts', ['src/auth'])).toBe(true);
    expect(isInScope('src/authx/a.ts', ['src/auth'])).toBe(false);
    expect(isInScope('src/pages/Login.tsx', ['src/pages/Login*'])).toBe(true);
    expect(isInScope('README.md', [])).toBe(false);
    expect(scopesOverlap(['a/**', 'b/**'], ['c/**', 'b/x'])).toBe(true);
  });
});

describe('permission rules (PLAN.md 10)', () => {
  const cwd = '/repo';
  it('matches Bash prefixes and file globs like Claude Code', () => {
    expect(matchesRule('Bash(npm test:*)', 'Bash', { command: 'npm test -- auth' }, cwd)).toBe(true);
    expect(matchesRule('Bash(npm test:*)', 'Bash', { command: 'npm testing' }, cwd)).toBe(false);
    expect(matchesRule('Bash(npm test:*)', 'Bash', { command: 'npm install' }, cwd)).toBe(false);
    expect(matchesRule('Edit(src/auth/**)', 'Edit', { file_path: '/repo/src/auth/a.ts' }, cwd)).toBe(true);
    expect(matchesRule('Edit(src/auth/**)', 'Edit', { file_path: 'src/pages/a.ts' }, cwd)).toBe(false);
    expect(matchesRule('Edit(src/auth/**)', 'Write', { file_path: 'src/auth/a.ts' }, cwd)).toBe(false);
    expect(matchesRule('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://api.example.com/x' }, cwd)).toBe(
      true
    );
    expect(matchesRule('Bash', 'Bash', { command: 'rm -rf /' }, cwd)).toBe(false);
  });

  it('suggests editable patterns and refuses blanket Bash', () => {
    expect(suggestRule('Bash', { command: 'npm install jsonwebtoken' }, cwd)).toBe('Bash(npm install:*)');
    expect(suggestRule('Bash', { command: 'ls -la' }, cwd)).toBe('Bash(ls:*)');
    expect(suggestRule('Write', { file_path: '/repo/docs/analysis.md' }, cwd)).toBe('Write(docs/**)');
    expect(suggestRule('Edit', { file_path: '/repo/README.md' }, cwd)).toBe('Edit(README.md)');
    expect(validateRule('Bash')).toMatch(/must not allow every Bash/);
    expect(validateRule('Bash(*)')).toMatch(/must not allow every Bash/);
    expect(validateRule('Bash(npm test:*)')).toBeNull();
  });
});

describe('ConcurrencyLimiter (PLAN.md 4.3)', () => {
  it('enforces the global and the lower session limit, FIFO', async () => {
    const limits: Record<string, number> = { s1: 1, s2: 5 };
    const limiter = new ConcurrencyLimiter((sid) => ({ global: 2, session: limits[sid] }));
    await limiter.acquire('s1', 'a');
    let bGranted = false;
    const b = limiter.acquire('s1', 'b').then(() => (bGranted = true));
    await limiter.acquire('s2', 'c'); // other session still has room
    let dGranted = false;
    const d = limiter.acquire('s2', 'd').then(() => (dGranted = true));
    await Promise.resolve();
    expect([bGranted, dGranted, limiter.runningCount()]).toEqual([false, false, 2]);

    limiter.release('c'); // frees a global slot: b's session is still full, d gets it
    await d;
    expect([bGranted, dGranted]).toEqual([false, true]);
    limiter.release('a');
    await b;
    expect(limiter.holds('b')).toBe(true);
  });

  it('cancel rejects a pending acquire', async () => {
    const limiter = new ConcurrencyLimiter(() => ({ global: 1, session: 1 }));
    await limiter.acquire('s', 'a');
    const pending = limiter.acquire('s', 'b');
    limiter.cancel('b', 'Interrupted');
    await expect(pending).rejects.toThrow('Interrupted');
  });
});

describe('FileLockManager (PLAN.md 5.2)', () => {
  it('refuses another agent, follows task lifetime, ignores case on macOS/Windows', () => {
    const locks = new FileLockManager();
    const a = { sessionId: 's', sessionAgentId: 'a', agentName: 'impl-1', taskId: 't1' };
    const b = { sessionId: 's', sessionAgentId: 'b', agentName: 'impl-2', taskId: 't2' };
    expect(locks.acquire('/repo/src/A.ts', a)).toEqual({ ok: true });
    expect(locks.acquire('/repo/src/A.ts', a)).toEqual({ ok: true });
    const conflict = locks.acquire(process.platform === 'linux' ? '/repo/src/A.ts' : '/repo/src/a.ts', b);
    expect(conflict.ok).toBe(false);
    locks.releaseTask('t1');
    expect(locks.acquire('/repo/src/A.ts', b)).toEqual({ ok: true });
    expect(locks.acquire('/repo/src/A.ts', a, Date.now() + 31 * 60_000)).toEqual({ ok: true }); // lease expired
  });
});

describe('default Supervisor (PLAN.md 4.1)', () => {
  it('picks Opus > Sonnet > Haiku, newest version, 1M variant', () => {
    expect(
      pickBestModel([
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: '' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: '' },
        { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
        { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
      ])
    ).toBe('claude-opus-5-5');
    expect(
      pickBestModel([
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
        { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5 (1M context)', description: '' },
      ])
    ).toBe('opus[1m]');
    expect(pickBestModel([{ value: 'inherit', displayName: 'Inherit', description: '' }])).toBeUndefined();
  });

  it('creates crewtree-supervisor once and never overwrites an edited one', async () => {
    const created = await ensureDefaultSupervisor();
    expect(created.scope).toBe('crewtree');
    expect(created.frontmatter).toMatchObject({ role: 'supervisor', canDelegate: true, delegates: '*' });
    fs.writeFileSync(created.path, created.content.replace('You are the Supervisor', 'EDITED'));
    const again = await ensureDefaultSupervisor();
    expect(again.content).toContain('EDITED');
  });
});

describe('git checkpoints (PLAN.md 5.4)', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString().trim();

  it('snapshots into a private ref without touching HEAD, index or working tree, and restores', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-git-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new');
    const head = git(repo, 'rev-parse', 'HEAD');
    const status = git(repo, 'status', '--porcelain');

    const cp = await GitCheckpoint.create(repo, 'sess', 'Build login');
    expect(cp).toMatchObject({ n: 1, ref: 'refs/crewtree/checkpoints/sess/1' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
    expect(git(repo, 'show', `${cp.ref}:a.txt`)).toBe('two');
    expect(git(repo, 'show', `${cp.ref}:new.txt`)).toBe('new');

    fs.writeFileSync(path.join(repo, 'a.txt'), 'three');
    await GitCheckpoint.restore(repo, cp.ref);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('two');
    expect((await GitCheckpoint.list(repo, 'sess')).map((c) => c.n)).toEqual([1]);
  });
});
