// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { DEFAULT_PORT } from '@crewtree/shared';
import { createServer } from '../src/index.js';
import { createSessionCookie } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { appSettingsTable, eventsTable, sessionsTable } from '../src/db/schema.js';
import { ProjectService } from '../src/projects/ProjectService.js';
import { ResourceScanner } from '../src/resources/ResourceScanner.js';
import { encodeResourceId } from '../src/resources/ids.js';
import { CommandWriter, MemoryWriter, SkillWriter } from '../src/resources/writers/configWriters.js';
import { McpService, unmask } from '../src/resources/mcp/McpService.js';
import { testMcpServer } from '../src/resources/mcp/mcpTest.js';
import { ClaudeCli } from '../src/claude/claudeCli.js';
import { MASK } from '../src/resources/secrets.js';
import { parseGeneratedConfig } from '../src/generate/ConfigGenerator.js';
import { cleanupEvents } from '../src/settings/maintenance.js';
import { SessionService } from '../src/sessions/SessionService.js';
import { claudeJsonPath } from '../src/resources/scan/mcp.js';

const claude = process.env.CLAUDE_CONFIG_DIR!;
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-p6-')));
const scanner = ResourceScanner.getInstance();
const cliCalls: string[][] = [];

beforeAll(() => {
  ProjectService.getInstance().open(project);
  // Stand-in for `claude mcp` / `claude plugin`: records the call and edits ~/.claude.json like the CLI
  ClaudeCli.setRunner(async (args) => {
    cliCalls.push(args);
    if (args[0] === 'mcp') {
      const file = claudeJsonPath();
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      data.mcpServers ??= {};
      if (args[1] === 'add-json') data.mcpServers[args[2]] = JSON.parse(args[3]);
      if (args[1] === 'remove') delete data.mcpServers[args[2]];
      fs.writeFileSync(file, JSON.stringify(data));
    }
    if (args[0] === 'plugin' && args[2] === 'missing@nowhere')
      return { code: 1, stdout: '', stderr: 'Plugin not found in any marketplace' };
    return { code: 0, stdout: 'ok', stderr: '' };
  });
});

afterAll(() => ClaudeCli.setRunner(undefined));

describe('skills, commands and memory writers (PLAN.md 6.3)', () => {
  it('creates a skill with supporting files, edits and rolls back a file, deletes it', () => {
    const skill = SkillWriter.create('user', [
      { path: 'SKILL.md', content: '---\nname: review\ndescription: Review code\n---\nSteps\n' },
      { path: 'docs/checklist.md', content: '- item\n' },
    ]);
    expect(skill.name).toBe('review');
    expect(fs.readFileSync(path.join(claude, 'skills', 'review', 'docs', 'checklist.md'), 'utf8')).toBe('- item\n');
    expect(() => SkillWriter.writeFile(skill.id, '../escape.md', 'x')).toThrow(/outside/);
    expect(() => SkillWriter.writeFile(skill.id, 'SKILL.md', '---\nname: other\ndescription: x\n---\nbody')).toThrow(
      /Renaming/
    );
    expect(() => SkillWriter.writeFile(skill.id, 'SKILL.md', '---\nname: review\n---\nbody')).toThrow(/description/);

    SkillWriter.writeFile(skill.id, 'docs/checklist.md', '- item\n- more\n');
    const history = SkillWriter.history(skill.id, 'docs/checklist.md');
    expect(history.map((r) => r.action)).toEqual(['update', 'create']);
    SkillWriter.writeFile(skill.id, 'docs/checklist.md', history[1].content, 'rollback');
    expect(fs.readFileSync(path.join(claude, 'skills', 'review', 'docs', 'checklist.md'), 'utf8')).toBe('- item\n');

    SkillWriter.deleteFile(skill.id, 'docs/checklist.md');
    expect(SkillWriter.readFile(skill.id, 'SKILL.md').content).toContain('Steps');
    SkillWriter.delete(skill.id);
    expect(fs.existsSync(path.join(claude, 'skills', 'review'))).toBe(false);
  });

  it('creates namespaced commands and keeps CRLF on update', () => {
    const item = CommandWriter.create('project', 'git/ship', '---\ndescription: Ship it\n---\nShip $ARGUMENTS\n');
    const file = path.join(project, '.claude', 'commands', 'git', 'ship.md');
    expect(item.metadata.namespace).toBe('git');
    fs.writeFileSync(file, '---\r\ndescription: Ship it\r\n---\r\nOld\r\n');
    scanner.invalidate('command');
    CommandWriter.update(item.id, '---\ndescription: Ship it\n---\nNew\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('---\r\ndescription: Ship it\r\n---\r\nNew\r\n');
    expect(CommandWriter.history(item.id).map((r) => r.action)).toEqual(['update', 'baseline', 'create']);
    expect(() => CommandWriter.create('project', '../x', 'y')).toThrow(/letters/);
    CommandWriter.delete(item.id);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('creates and edits memory files, including auto memory', () => {
    const local = MemoryWriter.create('local', '# Local\n');
    expect(local.scope).toBe('local');
    MemoryWriter.update(local.id, '# Local\n- rule\n');
    expect(fs.readFileSync(path.join(project, 'CLAUDE.local.md'), 'utf8')).toContain('- rule');
    expect(() => MemoryWriter.create('local', 'again')).toThrow(/exists/);
    const auto = MemoryWriter.create('auto', 'note', 'facts');
    expect(auto.metadata.role).toBe('auto');
    expect(() => MemoryWriter.create('auto', 'x', '../evil')).toThrow();
  });
});

describe('MCP servers (PLAN.md 6.3)', () => {
  it('keeps masked secrets and refuses masks with no stored value', () => {
    const previous = { command: 'npx', env: { TOKEN: 'secret' } };
    expect(unmask({ command: 'npx', env: { TOKEN: MASK, OTHER: 'x' } }, previous).env).toEqual({
      TOKEN: 'secret',
      OTHER: 'x',
    });
    expect(() => unmask({ command: 'npx', env: { NEW: MASK } }, previous)).toThrow(/masked/);
  });

  it('saves user servers through `claude mcp` and project servers to .mcp.json', async () => {
    await McpService.save({
      scope: 'user',
      name: 'github',
      config: { type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { TOKEN: 'abc' } },
    });
    expect(cliCalls.at(-1)?.slice(0, 3)).toEqual(['mcp', 'add-json', 'github']);
    const id = encodeResourceId('mcp', 'user', 'github');
    expect(scanner.find(id)?.metadata.config.env.TOKEN).toBe(MASK);
    // Editing with the masked value keeps the secret
    await McpService.save({
      scope: 'user',
      name: 'github',
      originalName: 'github',
      config: { command: 'npx', args: ['-y', 'gh2'], env: { TOKEN: MASK } },
    });
    const stored = JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf8')).mcpServers.github;
    expect(stored).toMatchObject({ args: ['-y', 'gh2'], env: { TOKEN: 'abc' } });
    await expect(McpService.save({ scope: 'user', name: 'github', config: { command: 'x' } })).rejects.toThrow(
      /exists/
    );

    await McpService.save({ scope: 'project', name: 'docs', config: { type: 'http', url: 'https://example.com/mcp' } });
    expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers.docs.url).toBe(
      'https://example.com/mcp'
    );
    McpService.setProjectServerEnabled('docs', false);
    const local = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    expect(local.disabledMcpjsonServers).toEqual(['docs']);

    await McpService.remove('user', 'github');
    expect(cliCalls.at(-1)?.slice(0, 3)).toEqual(['mcp', 'remove', 'github']);
  });

  it('tests a stdio server with initialize + tools/list', async () => {
    const server = path.join(project, 'fake-mcp.cjs');
    fs.writeFileSync(
      server,
      `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);` +
        `if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fake',version:'1.0'}}})+'\\n');` +
        `if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'a'},{name:'b'}]}})+'\\n');}});`
    );
    const ok = await testMcpServer({ command: process.execPath, args: [server] }, project);
    expect(ok).toMatchObject({ ok: true, serverName: 'fake', tools: ['a', 'b'] });
    const bad = await testMcpServer({ command: process.execPath, args: ['-e', 'process.exit(3)'] }, project);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/code 3/);
  }, 30_000);
});

describe('AI Generate for config (PLAN.md 6.4)', () => {
  it('parses each kind and drops escaping paths', () => {
    const skill = parseGeneratedConfig(
      'skill',
      JSON.stringify({
        name: 'My Skill',
        files: [
          { path: 'SKILL.md', content: 'x' },
          { path: '../../evil', content: 'y' },
        ],
      })
    );
    expect(skill.name).toBe('my-skill');
    expect(skill.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(() =>
      parseGeneratedConfig('skill', JSON.stringify({ name: 'a', files: [{ path: 'x.md', content: '' }] }))
    ).toThrow(/SKILL.md/);
    expect(parseGeneratedConfig('mcp', '{"name":"gh","config":{"command":"npx"}}').config.type).toBe('stdio');
  });
});

describe('Phase 6 API', () => {
  let app: FastifyInstance;
  const HOST = `127.0.0.1:${DEFAULT_PORT}`;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: HOST },
      cookies: { crewtree_session: createSessionCookie() },
      payload: payload as any,
    });

  beforeAll(async () => {
    app = await createServer();
  });
  afterAll(async () => {
    await app.close();
  });

  it('creates, reads, updates and deletes a command over HTTP', async () => {
    const created = await call('POST', '/api/resources/commands', {
      scope: 'user',
      name: 'hello',
      content: '---\ndescription: Hi\n---\nSay hi\n',
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().item.id;
    expect((await call('PUT', `/api/resources/commands/${id}`, { content: 'Say hello\n' })).statusCode).toBe(200);
    const detail = (await call('GET', `/api/resources/commands/${id}`)).json();
    expect(detail.content).toBe('Say hello\n');
    expect(detail.revisions.map((r: any) => r.action)).toEqual(['update', 'create']);
    const rollback = await call('POST', `/api/resources/commands/${id}/rollback`, {
      revisionId: detail.revisions[1].id,
    });
    expect(rollback.statusCode).toBe(200);
    expect((await call('DELETE', `/api/resources/commands/${id}`)).statusCode).toBe(200);
  });

  it('serves skill files and usage by agents', async () => {
    const created = await call('POST', '/api/resources/skills', {
      scope: 'project',
      files: [
        { path: 'SKILL.md', content: '---\nname: lint\ndescription: Lint files\n---\nRun lint\n' },
        { path: 'rules.md', content: '- no any\n' },
      ],
    });
    const id = created.json().item.id;
    const detail = (await call('GET', `/api/resources/skills/${id}`)).json();
    expect(detail.files.map((f: any) => f.path)).toEqual(['SKILL.md', 'rules.md']);
    const file = (await call('GET', `/api/resources/skills/${id}/file?path=rules.md`)).json();
    expect(file.content).toBe('- no any\n');
    expect(
      (await call('PUT', `/api/resources/skills/${id}`, { path: 'rules.md', content: '- strict\n' })).statusCode
    ).toBe(200);
    expect((await call('DELETE', `/api/resources/skills/${id}?path=rules.md`)).statusCode).toBe(200);
  });

  it('runs plugin actions through the CLI and reports its errors', async () => {
    expect((await call('POST', '/api/plugins/enabled', { id: 'helper@mkt', enabled: false })).statusCode).toBe(200);
    expect(cliCalls.at(-1)).toEqual(['plugin', 'disable', 'helper@mkt', '--scope', 'user']);
    const failed = await call('POST', '/api/plugins/install', { id: 'missing@nowhere' });
    expect(failed.statusCode).toBe(404);
    expect(failed.json().error).toMatch(/not found in any marketplace/);
    expect((await call('POST', '/api/plugins/install', { id: 'bad id; rm -rf' })).statusCode).toBe(400);
    expect((await call('GET', '/api/plugins/marketplaces')).statusCode).toBe(200);
  });

  it('streams AI Generate for a skill and refuses an empty request', async () => {
    const res = await call('POST', '/api/generate/skill', { description: 'A skill that formats SQL' });
    expect(res.body).toContain('event: result');
    expect((await call('POST', '/api/generate/skill', {})).statusCode).toBe(400);
    expect((await call('POST', '/api/generate/memory', { mode: 'cleanup' })).statusCode).toBe(400);
    expect((await call('POST', '/api/generate/nothing', { description: 'x' })).statusCode).toBe(404);
  });

  it('applies session defaults from settings and cleans up old events', async () => {
    await call('PATCH', '/api/settings', {
      limits: { session: { maxDepth: 2, maxTurns: 9 }, defaults: { maxConcurrentAgents: 2 } },
    });
    const settings = SessionService.getInstance().resolveSettings({}).data!;
    // resolveSettings with no base uses the app defaults
    expect(settings.limits).toMatchObject({ maxDepth: 2, maxTurns: 9, maxConcurrentAgents: 2 });

    const sessionId = nanoid();
    const old = Date.now() - 40 * 24 * 3600 * 1000;
    getDb()
      .insert(sessionsTable)
      .values({
        id: sessionId,
        title: 'old',
        cwd: project,
        supervisorAgentId: 'x',
        status: 'completed',
        settings: '{}',
        createdAt: old,
        updatedAt: old,
      })
      .run();
    getDb().insert(eventsTable).values({ sessionId, type: 'agent.status', payload: '{}', ts: old }).run();
    expect(cleanupEvents(30)).toBe(1);
    expect(getDb().select().from(eventsTable).where(eq(eventsTable.sessionId, sessionId)).all()).toHaveLength(0);
    expect((await call('POST', '/api/settings/cleanup')).json()).toHaveProperty('deleted');
    getDb().delete(appSettingsTable).run();
  });
});
