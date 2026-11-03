// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentEvent } from '@crewtree/shared';
import { DEFAULT_PORT } from '@crewtree/shared';
import { ProjectService } from '../src/projects/ProjectService.js';
import { ResourceScanner } from '../src/resources/ResourceScanner.js';
import { ResourceWatcher } from '../src/resources/ResourceWatcher.js';
import { AgentWriter } from '../src/resources/agents/agentWriter.js';
import { listLibraryAgents } from '../src/resources/agents/agentLibrary.js';
import { Revisions } from '../src/resources/revisions.js';
import { encodeResourceId } from '../src/resources/ids.js';
import { MASK } from '../src/resources/secrets.js';
import { createServer } from '../src/index.js';
import { createSessionCookie } from '../src/auth.js';
import { recordEvents, waitFor } from './helpers/tree.js';

const claude = process.env.CLAUDE_CONFIG_DIR!;
const crewtree = process.env.CREWTREE_DIR!;
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-res-proj-'));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const agentMd = (name: string, extra = '', body = `You are ${name}.`) =>
  `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\n${body}\n`;

const scanner = ResourceScanner.getInstance();
const id = (scope: Parameters<typeof encodeResourceId>[1], name: string) => encodeResourceId('agent', scope, name);
let events: AgentEvent[];

beforeAll(() => {
  // Agents in every scope; "reviewer" exists in Crewtree, User and Project
  write(path.join(crewtree, 'agents', 'reviewer.md'), agentMd('reviewer', 'model: haiku\n'));
  write(path.join(crewtree, 'agents', 'ops.md'), agentMd('ops'));
  write(path.join(claude, 'agents', 'reviewer.md'), agentMd('reviewer', 'model: sonnet\n'));
  write(path.join(claude, 'agents', 'writer.md'), agentMd('writer', 'tools: Read, Write\ncolor: blue\n'));
  write(path.join(project, '.claude', 'agents', 'reviewer.md'), agentMd('reviewer', 'model: opus\n'));

  // Plugin (enabled) with an agent, a skill and an MCP server
  const pluginDir = path.join(claude, 'plugins', 'cache', 'mkt', 'helper', '1.0.0');
  write(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'helper', description: 'Helps' })
  );
  write(path.join(pluginDir, 'agents', 'plugin-agent.md'), agentMd('plugin-agent'));
  write(path.join(pluginDir, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lints code\n---\nRun lint.');
  write(path.join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: { linter: { command: 'lint-mcp' } } }));
  write(
    path.join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'helper@mkt': [{ scope: 'user', installPath: pluginDir, version: '1.0.0' }] },
    })
  );
  write(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'helper@mkt': true } }));

  // Skills: a real folder, a symlinked folder, a synced one, a project one
  write(path.join(claude, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nSteps');
  write(path.join(claude, 'skills', 'review', 'checklist.md'), '- item');
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-linked-skill-'));
  write(path.join(linked, 'SKILL.md'), '---\nname: linked\ndescription: Linked skill\n---\nx');
  fs.symlinkSync(linked, path.join(claude, 'skills', 'linked'));
  write(
    path.join(claude, 'skills', 'synced', 'bucket-1', 'docs', 'SKILL.md'),
    '---\nname: docs\ndescription: Synced\n---\nx'
  );
  write(
    path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy\n---\nx'
  );

  // Commands with a namespace folder
  write(
    path.join(claude, 'commands', 'review-pr.md'),
    '---\ndescription: Review a PR\nargument-hint: <number>\n---\nReview $1'
  );
  write(path.join(project, '.claude', 'commands', 'db', 'migrate.md'), 'Create a migration');

  // Memory with an import
  write(path.join(claude, 'CLAUDE.md'), '@RULES.md\n# Me\n');
  write(path.join(claude, 'RULES.md'), '# Rules\nBe brief.');
  write(path.join(project, 'CLAUDE.md'), '# Project memory\n');

  // MCP: user + local in .claude.json (CLAUDE_CONFIG_DIR keeps it next to ~/.claude), project .mcp.json
  write(
    path.join(claude, '.claude.json'),
    JSON.stringify({
      mcpServers: { github: { command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'ghp_secret' } } },
      projects: {
        [project]: {
          mcpServers: {
            local_db: {
              type: 'http',
              url: 'https://db.local/mcp?token=abc123',
              headers: { Authorization: 'Bearer x' },
            },
          },
        },
      },
    })
  );
  write(
    path.join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { postgres: { command: 'pg-mcp', env: { PGPASSWORD: 'pw' } } } })
  );

  ProjectService.getInstance().open(project);
  events = recordEvents();
});

describe('ResourceScanner (PLAN.md 6.1)', () => {
  it('lists agents of every scope with precedence Project > User > Crewtree and built-ins', () => {
    const agents = scanner.list('agent');
    const reviewers = agents
      .filter((a) => a.name === 'reviewer')
      .map((a) => [a.scope, a.shadowedBy ?? null, a.metadata.model]);
    expect(reviewers).toEqual([
      ['project', null, 'opus'],
      ['user', 'project', 'sonnet'],
      ['crewtree', 'project', 'haiku'],
    ]);
    expect(agents.find((a) => a.name === 'plugin-agent')).toMatchObject({
      scope: 'plugin',
      readOnly: true,
      plugin: 'helper@mkt',
    });
    expect(agents.find((a) => a.name === 'Explore')).toMatchObject({ scope: 'builtin', readOnly: true });
    expect(agents.find((a) => a.name === 'writer')!.metadata).toMatchObject({
      tools: ['Read', 'Write'],
      color: 'blue',
    });

    // Sessions use the winner of each name; built-ins are never nodes
    const library = listLibraryAgents(project);
    expect(library.find((a) => a.name === 'reviewer')!.scope).toBe('project');
    expect(library.some((a) => a.name === 'Explore')).toBe(false);
    expect(library.some((a) => a.name === 'plugin-agent')).toBe(true);
  });

  it('lists skills (symlinks followed, synced read-only), commands, memory, MCP and plugins', () => {
    expect(
      scanner
        .list('skill')
        .map((s) => `${s.name}:${s.scope}:${s.readOnly}`)
        .sort()
    ).toEqual(['deploy:project:false', 'docs:user:true', 'linked:user:false', 'lint:plugin:true', 'review:user:false']);
    expect(scanner.list('skill').find((s) => s.name === 'review')!.metadata.files).toBe(2);

    expect(scanner.list('command').map((c) => [c.name, c.scope, c.metadata.namespace ?? null])).toEqual([
      ['migrate', 'project', 'db'],
      ['review-pr', 'user', null],
    ]);

    const memory = scanner.list('memory');
    expect(memory.map((m) => [m.name, m.scope, m.metadata.role])).toEqual([
      ['CLAUDE.md', 'user', 'user'],
      ['RULES.md', 'user', 'import'],
      ['CLAUDE.md', 'project', 'project'],
    ]);

    const plugin = scanner.list('plugin')[0];
    expect(plugin).toMatchObject({ name: 'helper@mkt', readOnly: true });
    expect(plugin.metadata).toMatchObject({
      enabled: true,
      version: '1.0.0',
      components: { agents: 1, skills: 1, mcpServers: 1 },
    });
  });

  it('never returns MCP secrets in clear', () => {
    const mcp = Object.fromEntries(scanner.list('mcp').map((m) => [m.name, m]));
    expect(Object.keys(mcp).sort()).toEqual(['github', 'linter', 'local_db', 'postgres']);
    expect([mcp.github.scope, mcp.local_db.scope, mcp.postgres.scope, mcp.linter.scope]).toEqual([
      'user',
      'local',
      'project',
      'plugin',
    ]);
    const all = JSON.stringify(scanner.list('mcp'));
    for (const secret of ['ghp_secret', 'abc123', 'Bearer x', '"pw"']) expect(all).not.toContain(secret);
    expect((mcp.github.metadata.config as any).env.GITHUB_TOKEN).toBe(MASK);
  });
});

describe('AgentWriter (PLAN.md 6.3)', () => {
  it('creates, renames, keeps CRLF, and records revisions', () => {
    const created = AgentWriter.create('user', agentMd('tester', 'model: haiku\n'));
    expect(created.path).toBe(path.join(claude, 'agents', 'tester.md'));
    expect(() => AgentWriter.create('user', agentMd('tester'))).toThrow(/already exists/);

    // A file written by an editor on Windows keeps its CRLF line endings
    fs.writeFileSync(created.path, agentMd('tester', 'model: haiku\n').replace(/\n/g, '\r\n'));
    scanner.invalidate('agent');
    const renamed = AgentWriter.update(created.item.id, agentMd('qa-tester', 'model: sonnet\n'));
    expect(fs.existsSync(created.path)).toBe(false);
    expect(renamed.path).toBe(path.join(claude, 'agents', 'qa-tester.md'));
    expect(fs.readFileSync(renamed.path, 'utf8')).toContain('\r\n');
    expect(Revisions.list('agent', 'qa-tester').map((r) => r.action)).toEqual(['update']);
    expect(Revisions.list('agent', 'tester').map((r) => r.action)).toEqual(['baseline', 'create']);
  });

  it('validates frontmatter and refuses read-only sources', () => {
    expect(() => AgentWriter.create('user', 'no frontmatter')).toThrow(/frontmatter/);
    expect(() => AgentWriter.create('user', '---\nname: bad name\n---\nx')).toThrow(/name may only contain/);
    expect(() => AgentWriter.create('user', '---\nname: empty\n---\n')).toThrow(/system prompt/);
    expect(() => AgentWriter.create('plugin', agentMd('x'))).toThrow(/Crewtree, User or Project/);
    const pluginAgent = scanner.list('agent').find((a) => a.name === 'plugin-agent')!;
    expect(() => AgentWriter.update(pluginAgent.id, agentMd('plugin-agent'))).toThrow(/read-only/);
  });

  it('duplicates read-only agents into the User scope ("Duplicate as mine")', () => {
    const pluginAgent = scanner.list('agent').find((a) => a.name === 'plugin-agent')!;
    const copy = AgentWriter.duplicate(pluginAgent.id);
    expect(copy.item).toMatchObject({ name: 'plugin-agent-copy', scope: 'user', readOnly: false });
    expect(AgentWriter.duplicate(pluginAgent.id).item.name).toBe('plugin-agent-copy-2');
    const builtin = scanner.list('agent').find((a) => a.scope === 'builtin')!;
    expect(() => AgentWriter.duplicate(builtin.id)).toThrow(/built-in/);
  });

  it('moves between scopes and the history follows the agent', () => {
    const moved = AgentWriter.move(id('crewtree', 'ops'), 'project');
    expect(moved.path).toBe(path.join(project, '.claude', 'agents', 'ops.md'));
    expect(fs.existsSync(path.join(crewtree, 'agents', 'ops.md'))).toBe(false);
    expect(() => AgentWriter.move(id('crewtree', 'reviewer'), 'user')).toThrow(/already exists/);
    expect(Revisions.list('agent', 'ops').map((r) => [r.action, r.scope])).toEqual([
      ['move', 'project'],
      ['baseline', 'crewtree'],
    ]);
  });

  it('restores a deleted agent and rolls back an edit', () => {
    const writer = id('user', 'writer');
    const original = fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8');
    AgentWriter.update(writer, agentMd('writer', 'model: opus\n', 'Changed prompt.'));
    const baseline = Revisions.list('agent', 'writer').find((r) => r.action === 'baseline')!;
    AgentWriter.rollback(baseline.id, writer);
    expect(fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8')).toBe(original);

    AgentWriter.delete(writer);
    expect(scanner.find(writer)).toBeUndefined();
    const deleted = Revisions.list('agent', 'writer').find((r) => r.action === 'delete')!;
    AgentWriter.rollback(deleted.id);
    expect(fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8')).toBe(original);
    expect(Revisions.list('agent', 'writer')[0].action).toBe('rollback');
  });

  it('changes the model of several agents, keeping the rest of each file', () => {
    const before = fs.readFileSync(path.join(project, '.claude', 'agents', 'reviewer.md'), 'utf8');
    const pluginAgent = scanner.list('agent').find((a) => a.name === 'plugin-agent')!;
    const results = AgentWriter.bulkModel(
      [id('project', 'reviewer'), id('crewtree', 'reviewer'), pluginAgent.id],
      'claude-sonnet-5-5'
    );
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['reviewer', true],
      ['reviewer', true],
      ['plugin-agent', false],
    ]);
    const after = fs.readFileSync(path.join(project, '.claude', 'agents', 'reviewer.md'), 'utf8');
    expect(after).toBe(before.replace('model: opus', 'model: claude-sonnet-5-5'));
  });
});

describe('ResourceWatcher', () => {
  it('announces files changed outside Crewtree within about a second', async () => {
    ResourceWatcher.getInstance().start();
    await new Promise((r) => setTimeout(r, 400));
    const count = scanner.list('command').length;
    write(path.join(claude, 'commands', 'deploy.md'), 'Deploy it');
    await waitFor(
      () =>
        events.some(
          (e) => e.type === 'resource.changed' && e.payload.kind === 'command' && e.payload.source === 'watcher'
        ),
      3000,
      'command change announced'
    );
    expect(scanner.list('command').length).toBe(count + 1);
    await ResourceWatcher.getInstance().stop();
  });

  it('maps paths to resource kinds', () => {
    const kind = (p: string) => ResourceWatcher.kindOf(p, project);
    expect(kind(path.join(project, '.claude', 'agents', 'a.md'))).toBe('agent');
    expect(kind(path.join(claude, 'skills', 'x', 'SKILL.md'))).toBe('skill');
    expect(kind(path.join(project, '.mcp.json'))).toBe('mcp');
    expect(kind(path.join(project, 'CLAUDE.md'))).toBe('memory');
    expect(kind(path.join(claude, 'settings.json'))).toBe('plugin');
  });
});

describe('resource API (PLAN.md 15.1)', () => {
  let app: FastifyInstance;
  const HOST = `127.0.0.1:${DEFAULT_PORT}`;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
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

  it('lists, reads with revisions, creates, conflicts, exports', async () => {
    const list = (await call('GET', '/api/resources/agents?scope=project')).json();
    expect(list.every((a: any) => a.scope === 'project')).toBe(true);

    const created = await call('POST', '/api/resources/agents', { scope: 'crewtree', content: agentMd('api-agent') });
    expect(created.statusCode).toBe(200);
    expect(
      (await call('POST', '/api/resources/agents', { scope: 'crewtree', content: agentMd('api-agent') })).statusCode
    ).toBe(409);

    const agentId = created.json().item.id;
    const detail = (await call('GET', `/api/resources/agents/${agentId}`)).json();
    expect(detail.content).toContain('You are api-agent.');
    expect(detail.revisions.map((r: any) => r.action)).toEqual(['create']);
    expect(detail.revisions[0].content).toBeUndefined();

    const exported = await call('GET', `/api/resources/agents/${agentId}/export`);
    expect(exported.headers['content-disposition']).toContain('api-agent.md');
    expect(exported.body).toContain('name: api-agent');

    expect((await call('POST', '/api/resources/skills', { content: 'x' })).statusCode).toBe(400);
    expect((await call('GET', '/api/resources/widgets')).statusCode).toBe(404);
  });

  it('switches project and rescans the project scope', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-res-other-'));
    write(path.join(other, '.claude', 'agents', 'only-here.md'), agentMd('only-here'));
    const res = await call('POST', '/api/projects/open', { path: other });
    expect(res.json().current.path).toBe(other);
    expect(scanner.list('agent').some((a) => a.name === 'only-here')).toBe(true);
    expect((await call('GET', '/api/projects')).json().recent.map((p: any) => p.path)).toContain(other);
    expect((await call('POST', '/api/projects/open', { path: '/does/not/exist' })).statusCode).toBe(404);
    ProjectService.getInstance().open(project);
  });
});
