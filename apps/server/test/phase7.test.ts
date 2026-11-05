// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_PORT, assetName, compareVersions, parseVersion } from '@crewtree/shared';
import { createServer } from '../src/index.js';
import { getShutdownTokenPath } from '../src/paths.js';
import { currentVersion } from '../src/version.js';

describe('versions (PLAN.md 16.4)', () => {
  it('orders semver including pre-releases', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(parseVersion('nope')).toBeNull();
  });

  it('names release assets per platform', () => {
    expect(assetName('0.2.0', 'darwin', 'arm64')).toBe('crewtree-v0.2.0-darwin-arm64.tar.gz');
    expect(assetName('v0.2.0', 'win32', 'x64')).toBe('crewtree-v0.2.0-win32-x64.zip');
  });

  it('reads the running version from the monorepo in a checkout', () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('CLI endpoints (PLAN.md 16.3)', () => {
  let app: FastifyInstance;
  const HOST = `127.0.0.1:${DEFAULT_PORT}`;
  beforeAll(async () => {
    app = await createServer();
    fs.writeFileSync(getShutdownTokenPath(), 'cli-token-for-tests');
  });
  afterAll(async () => {
    await app.close();
  });

  it('gives a one-time login link only with the shutdown token', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/cli/open',
      headers: { host: HOST },
      payload: { token: 'wrong-token-for-tests' },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/cli/open',
      headers: { host: HOST },
      payload: { token: 'cli-token-for-tests' },
    });
    expect(ok.statusCode).toBe(200);
    const url = new URL(ok.json().url);
    expect(url.pathname).toBe('/auth');
    const login = await app.inject({
      method: 'GET',
      url: `/auth?t=${url.searchParams.get('t')}`,
      headers: { host: HOST },
    });
    expect(login.statusCode).toBe(302);
    // one-time: the same link does not work twice
    expect(
      (await app.inject({ method: 'GET', url: `/auth?t=${url.searchParams.get('t')}`, headers: { host: HOST } }))
        .statusCode
    ).toBe(400);
  });

  it('refuses an unknown project folder', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cli/open',
      headers: { host: HOST },
      payload: { token: 'cli-token-for-tests', project: '/definitely/not/here' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports the version without calling GitHub when checks are off', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/version', headers: { host: HOST } });
    expect(res.json()).toMatchObject({ updateAvailable: false, disabled: true });
    const health = (await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } })).json();
    expect(health.version).toBe(currentVersion());
  });
});

describe('one server per data folder (instance lock)', () => {
  it('takes over a pid file left by a crash, keeps a live one, and releases only its own', async () => {
    const { spawnSync } = await import('child_process');
    const { acquireInstanceLock, releaseInstanceLock } = await import('../src/instanceLock.js');
    const { getPidPath } = await import('../src/paths.js');
    const pidFile = getPidPath();
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!;
    fs.writeFileSync(pidFile, `${deadPid}`);
    expect(await acquireInstanceLock()).toEqual({ acquired: true });
    expect(fs.readFileSync(pidFile, 'utf8')).toBe(`${process.pid}`);
    releaseInstanceLock();
    expect(fs.existsSync(pidFile)).toBe(false);

    // Another server's lock is never removed by us
    fs.writeFileSync(pidFile, '424242');
    releaseInstanceLock();
    expect(fs.readFileSync(pidFile, 'utf8')).toBe('424242');
    fs.rmSync(pidFile);
  });
});
