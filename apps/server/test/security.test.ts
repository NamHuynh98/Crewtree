// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, injectBoot } from '../src/index.js';
import { createSessionCookie } from '../src/auth.js';
import { DEFAULT_PORT } from '@crewtree/shared';

const HOST = `127.0.0.1:${DEFAULT_PORT}`;
let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
});

afterAll(async () => {
  await app.close();
});

describe('local server security (PLAN.md 15.3)', () => {
  it('health is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.com' } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects localhost on an unexpected port', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:9999' } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requests without the session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed cookie without crashing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { host: HOST },
      cookies: { crewtree_session: '123.short' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects mutations from a foreign Origin even with a cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { host: HOST, origin: 'https://evil.com' },
      cookies: { crewtree_session: createSessionCookie() },
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects WebSocket upgrades without a cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/ws', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts authenticated same-origin requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { host: HOST, origin: `http://${HOST}` },
      cookies: { crewtree_session: createSessionCookie() },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('session settings', () => {
  it('creates with partial settings and patches them with validation', async () => {
    const cookies = { crewtree_session: createSessionCookie() };
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { host: HOST },
      cookies,
      payload: { title: 'S', cwd: process.cwd(), settings: { configGroups: { hooks: false } } },
    });
    const { session } = created.json();
    expect(session.settings.configGroups).toEqual({
      claudemd: true,
      skillsPlugins: true,
      hooks: false,
      permissions: true,
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}`,
      headers: { host: HOST },
      cookies,
      payload: { settings: { idleSuspendMinutes: 1 } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().settings).toMatchObject({ idleSuspendMinutes: 1, configGroups: { hooks: false } });

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}`,
      headers: { host: HOST },
      cookies,
      payload: { settings: { idleSuspendMinutes: -5 } },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('shell data for the UI (UI-WIREFRAMES 0)', () => {
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { host: HOST }, cookies: { crewtree_session: createSessionCookie() } });

  it('reports Claude Code login state and rate limiting', async () => {
    const res = await get('/api/claude/status');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ login: 'logged_in', rateLimited: false });
  });

  it('returns the current project and pending approvals', async () => {
    const project = (await get('/api/projects')).json().current;
    expect(project.path).toBeTruthy();
    expect(project.name).toBeTruthy();
    expect((await get('/api/approvals?status=pending')).json()).toEqual([]);
  });

  it('marks session activity for the status legend', async () => {
    const sessions = (await get('/api/sessions')).json();
    for (const s of sessions) expect(['running', 'idle']).toContain(s.activity);
  });

  it('requires the cookie for these endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/claude/status', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });
});

describe('boot settings (PLAN.md 11.1)', () => {
  it('persists UI language and injects it into index.html', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { host: HOST },
      cookies: { crewtree_session: createSessionCookie() },
      payload: { ui: { language: 'vi' } },
    });
    expect(patched.json().ui).toEqual({ language: 'vi', theme: 'system' }); // deep merge keeps theme

    const boot = await app.inject({ method: 'GET', url: '/api/boot', headers: { host: HOST } });
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toEqual({ language: 'vi', theme: 'system' });

    const html = injectBoot('<!doctype html><html lang="en"><head><title>x</title></head></html>');
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain('window.__BOOT__ = {"language":"vi","theme":"system"}');
  });
});

describe('session chat over REST with FakeDriver', () => {
  it('creates a session and gets a reply through the runtime pipeline', async () => {
    const cookies = { crewtree_session: createSessionCookie() };
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { host: HOST },
      cookies,
      payload: { title: 'Test', cwd: process.cwd() },
    });
    expect(created.statusCode).toBe(200);
    const { session } = created.json();

    const sent = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/messages`,
      headers: { host: HOST },
      cookies,
      payload: { content: 'ping' },
    });
    expect(sent.statusCode).toBe(200);

    let detail: any;
    for (let i = 0; i < 100 && !detail?.session.totalTokens; i++) {
      await new Promise((r) => setTimeout(r, 10));
      detail = (
        await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, headers: { host: HOST }, cookies })
      ).json();
    }
    expect(detail.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[1].content).toContain('ping');
    expect(detail.session.totalTokens).toBe(30); // input + output, cache reads excluded

    const events = (
      await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/events?after=0`,
        headers: { host: HOST },
        cookies,
      })
    ).json();
    expect(events.some((e: any) => e.type === 'agent.text.done')).toBe(true);
    expect(events.some((e: any) => e.type === 'agent.text.delta')).toBe(false);
  });
});
