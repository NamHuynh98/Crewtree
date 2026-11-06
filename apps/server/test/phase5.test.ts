// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { DEFAULT_PORT } from '@crewtree/shared';
import { createServer } from '../src/index.js';
import { createSessionCookie } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { fileTouchesTable, tasksTable } from '../src/db/schema.js';
import { EventBus } from '../src/events/EventBus.js';
import { SessionService } from '../src/sessions/SessionService.js';
import { fileDiff, lineStats, listChanges } from '../src/files/SessionChanges.js';
import { getSnapshotsDir } from '../src/paths.js';

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-p5-')));
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};

const sessions = SessionService.getInstance();
let sessionId = '';
let supervisorId = '';

function touch(rel: string, op: string, snapshot?: string) {
  let snapshotPath: string | null = null;
  if (snapshot !== undefined) {
    snapshotPath = path.join(getSnapshotsDir(), `${nanoid()}-snap`);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, snapshot);
  }
  getDb()
    .insert(fileTouchesTable)
    .values({ id: nanoid(), sessionId, sessionAgentId: supervisorId, path: rel, op, snapshotPath, ts: Date.now() })
    .run();
}

beforeAll(async () => {
  write('src/a.ts', 'one\ntwo\nthree\n');
  write('src/b.ts', 'keep\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const created = await sessions.createSession({ title: 'Phase 5', cwd: repo });
  sessionId = created.session.id;
  supervisorId = created.supervisorAgent.id;
});

afterAll(async () => {
  await sessions.deleteSession(sessionId);
});

describe('session changes (PLAN.md 9)', () => {
  it('counts lines as a multiset', () => {
    expect(lineStats('a\nb\nc', 'a\nc\nd\ne')).toEqual({ added: 2, removed: 1 });
    expect(lineStats('', 'x\ny')).toEqual({ added: 2, removed: 0 });
  });

  it('lists edited, added and deleted files against the session base', async () => {
    // Edited through a tool: snapshot taken before the first edit
    touch('src/a.ts', 'edit', 'one\ntwo\nthree\n');
    write('src/a.ts', 'one\n2\nthree\nfour\n');
    // Created during the session (Write, no snapshot)
    write('src/new.ts', 'x\ny\n');
    touch('src/new.ts', 'write');
    // Removed by a Bash command
    touch('src/b.ts', 'bash');
    fs.rmSync(path.join(repo, 'src/b.ts'));

    const changes = await listChanges(sessionId, repo);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath['src/a.ts']).toMatchObject({ status: 'modified', added: 2, removed: 1, viaBash: false });
    expect(byPath['src/new.ts']).toMatchObject({ status: 'added', added: 2, removed: 0 });
    expect(byPath['src/b.ts']).toMatchObject({ status: 'deleted', viaBash: true, removed: 1 });
    expect(byPath['src/a.ts'].agents[0].id).toBe(supervisorId);
    expect(await listChanges(sessionId, repo, 'someone-else')).toEqual([]);
  });

  it('diffs against HEAD and the session base', async () => {
    const head = await fileDiff(sessionId, repo, 'src/a.ts', 'head');
    expect(head.before).toBe('one\ntwo\nthree\n');
    expect(head.after).toBe('one\n2\nthree\nfour\n');
    const created = await fileDiff(sessionId, repo, 'src/new.ts', 'session');
    expect(created).toMatchObject({ before: '', beforeMissing: false });
    const untrackedHead = await fileDiff(sessionId, repo, 'src/new.ts', 'head');
    expect(untrackedHead.beforeMissing).toBe(true);
  });
});

describe('Phase 5 API', () => {
  let app: FastifyInstance;
  const HOST = `127.0.0.1:${DEFAULT_PORT}`;
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { host: HOST }, cookies: { crewtree_session: createSessionCookie() } });

  beforeAll(async () => {
    app = await createServer();
  });
  afterAll(async () => {
    await app.close();
  });

  it('enriches the sessions list and the session detail', async () => {
    EventBus.getInstance().emitEvent({
      sessionId,
      sessionAgentId: supervisorId,
      type: 'usage.updated',
      payload: { inputTokens: 100, outputTokens: 20, numTurns: 3 },
      ts: Date.now(),
    });
    EventBus.getInstance().emitEvent({
      sessionId,
      sessionAgentId: supervisorId,
      type: 'agent.tool.start',
      payload: { tool: 'Bash', toolUseId: 't1', input: { command: 'npm test' } },
      ts: Date.now(),
    });
    const row = (await get('/api/sessions')).json().items.find((s: any) => s.id === sessionId);
    expect(row).toMatchObject({ agentCount: 1, levels: 1 });
    expect(row.lastActiveAt).toBeGreaterThan(0);

    const detail = (await get(`/api/sessions/${sessionId}`)).json();
    expect(detail.agentStats[supervisorId]).toMatchObject({ tokens: 120, turns: 3 });
    expect(detail.agentStats[supervisorId].lastTool).toMatchObject({ tool: 'Bash', input: { command: 'npm test' } });
    expect(detail.agentStats[supervisorId].filesTouched).toBeGreaterThanOrEqual(3);
  });

  it('pages events backwards for "Load older"', async () => {
    const all = (await get(`/api/sessions/${sessionId}/events?after=0`)).json();
    const last = all[all.length - 1].id;
    const older = (await get(`/api/sessions/${sessionId}/events?before=${last}&limit=1`)).json();
    expect(older).toHaveLength(1);
    expect(older[0].id).toBe(all[all.length - 2].id);
  });

  it('pages and filters the sessions list on the server', async () => {
    const tag = `Paged ${nanoid(6)}`;
    const extra = [];
    for (let i = 0; i < 3; i++)
      extra.push((await sessions.createSession({ title: `${tag} ${i}`, cwd: repo })).session.id);
    try {
      const first = (await get(`/api/sessions?q=${encodeURIComponent(tag.toLowerCase())}&limit=2`)).json();
      expect(first.total).toBe(3);
      expect(first.items).toHaveLength(2);
      expect(first.cwds).toContain(repo);
      const rest = (await get(`/api/sessions?q=${encodeURIComponent(tag)}&limit=2&offset=2`)).json();
      expect(rest.items).toHaveLength(1);
      const ids = [...first.items, ...rest.items].map((s: any) => s.id);
      expect(new Set(ids)).toEqual(new Set(extra));
      expect((await get(`/api/sessions?q=${encodeURIComponent(tag)}&cwd=/nowhere`)).json().total).toBe(0);
      expect((await get(`/api/sessions?q=${encodeURIComponent(tag)}&status=running`)).json().total).toBe(0);
    } finally {
      for (const id of extra) await sessions.deleteSession(id);
    }
  });

  it('leaves long task details out of the session detail', async () => {
    const taskId = nanoid();
    getDb()
      .insert(tasksTable)
      .values({
        id: taskId,
        sessionId,
        toAgentId: supervisorId,
        title: 'Report',
        instructions: 'Write it',
        scope: '[]',
        status: 'done',
        resultSummary: 'short',
        resultDetails: 'a long report',
        createdAt: Date.now(),
      })
      .run();
    const task = (await get(`/api/sessions/${sessionId}`)).json().tasks.find((x: any) => x.id === taskId);
    expect(task).toMatchObject({ resultSummary: 'short', hasDetails: true });
    expect(task.resultDetails).toBeUndefined();
    const full = (await get(`/api/sessions/${sessionId}/tasks/${taskId}/result`)).json();
    expect(full.resultDetails).toBe('a long report');
  });

  it('serves the lazy tree, changes, diffs and process counts', async () => {
    const root = (await get(`/api/fs/tree?sessionId=${sessionId}`)).json();
    expect(root.entries.map((e: any) => e.path)).toContain('src');
    const src = (await get(`/api/fs/tree?sessionId=${sessionId}&dir=src`)).json();
    expect(src.entries.every((e: any) => e.path.startsWith('src/'))).toBe(true);
    expect((await get(`/api/fs/tree?sessionId=${sessionId}&dir=../..`)).statusCode).toBe(403);

    const changes = (await get(`/api/sessions/${sessionId}/changes`)).json();
    expect(changes.map((c: any) => c.path)).toContain('src/a.ts');

    const diff = (await get(`/api/fs/diff?sessionId=${sessionId}&path=src/a.ts&base=head`)).json();
    expect(diff.before).toBe('one\ntwo\nthree\n');
    expect((await get(`/api/fs/diff?sessionId=${sessionId}&path=src/a.ts&base=bogus`)).statusCode).toBe(400);

    expect((await get(`/api/fs/raw?sessionId=${sessionId}&path=src/a.ts`)).statusCode).toBe(400);

    const processes = (await get(`/api/sessions/${sessionId}/processes`)).json();
    expect(processes).toHaveProperty('running');
    expect(processes).toHaveProperty('suspended');
    // PowerShell process listing and git take a few seconds on Windows runners
  }, 30_000);
});
