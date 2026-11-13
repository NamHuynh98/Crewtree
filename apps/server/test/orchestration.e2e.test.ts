// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@crewtree/shared';
import { SessionService } from '../src/sessions/SessionService.js';
import { FakeDriver, FakeScenario } from '../src/runtime/drivers/FakeDriver.js';
import { ApprovalService } from '../src/approvals/ApprovalService.js';
import { getDb } from '../src/db/index.js';
import { fileTouchesTable } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { parse, recordEvents, taskIdIn, waitFor, writeAgent } from './helpers/tree.js';

/**
 * PLAN.md 4.4 / 18: three-level tree on FakeDriver, no tokens.
 * Supervisor → researcher, analyst (asks a question), lead-coder → spawns 2 implementers with disjoint scopes.
 */
const scripts: Record<string, FakeScenario> = {
  'crewtree-supervisor': (content, _sid, api) =>
    (async () => {
      if (content.startsWith('[Crewtree]')) return api.text('Noted.');
      const team = parse((await api.callTool('list_agents')).text);
      const id = (name: string) => team.find((a: any) => a.agent === name).agentId;
      const t1 = parse(
        (
          await api.callTool('delegate_task', {
            agentId: id('researcher'),
            title: 'Research JWT',
            instructions: 'Find best practice',
          })
        ).text
      );
      const t2 = parse(
        (
          await api.callTool('delegate_task', {
            agentId: id('analyst'),
            title: 'Analyse auth',
            instructions: 'Analyse requirements',
          })
        ).text
      );
      for (;;) {
        const r = parse(
          (await api.callTool('wait_for_tasks', { taskIds: [t1.taskId, t2.taskId], timeoutSec: 30 })).text
        );
        for (const q of r.questions) await api.callTool('answer_child', { taskId: q.taskId, answer: 'Use SQLite' });
        if (!r.questions.length && !r.still_running.length) break;
      }
      const t3 = parse(
        (
          await api.callTool('delegate_task', {
            agentId: id('lead-coder'),
            title: 'Build login + auth API',
            instructions: 'Implement',
            scope: ['src/auth/**', 'src/pages/**'],
          })
        ).text
      );
      for (;;) {
        const r = parse((await api.callTool('wait_for_tasks', { taskIds: [t3.taskId], timeoutSec: 30 })).text);
        if (!r.still_running.length && !r.questions.length) break;
      }
      await api.text('Report: research, analysis and implementation are done.');
    })(),

  researcher: (content, _s, api) =>
    (async () => {
      await api.text('Researching…');
      await api.callTool('complete_task', { taskId: taskIdIn(content), summary: 'JWT with refresh tokens' });
    })(),

  analyst: (content, _s, api) =>
    (async () => {
      if (content.startsWith('[Crewtree task')) {
        analystTask = taskIdIn(content);
        await api.callTool('ask_parent', { taskId: analystTask, question: 'Which database?' });
        return;
      }
      await api.callTool('complete_task', {
        taskId: analystTask,
        summary: `Analysis done: ${content.includes('SQLite') ? 'SQLite' : '?'}`,
      });
    })(),

  'lead-coder': (content, _s, api) =>
    (async () => {
      if (!content.startsWith('[Crewtree task')) return api.text('ok');
      const a = parse((await api.callTool('spawn_agent', { agentName: 'implementer', alias: 'impl-1' })).text);
      const b = parse((await api.callTool('spawn_agent', { agentName: 'implementer', alias: 'impl-2' })).text);
      const denied = await api.callTool('spawn_agent', { agentName: 'researcher' });
      leadNotes.spawnDenied = denied.text;
      const t1 = parse(
        (
          await api.callTool('delegate_task', {
            agentId: a.agentId,
            title: 'Auth API',
            instructions: 'Write src/auth',
            scope: ['src/auth/**'],
          })
        ).text
      );
      const t2 = parse(
        (
          await api.callTool('delegate_task', {
            agentId: b.agentId,
            title: 'Login page',
            instructions: 'Write src/pages',
            scope: ['src/pages/**'],
          })
        ).text
      );
      leadNotes.overlap = (
        await api.callTool('delegate_task', {
          agentId: b.agentId,
          title: 'Overlap',
          instructions: 'x',
          scope: ['src/auth/login.ts'],
        })
      ).text;
      for (;;) {
        const r = parse(
          (await api.callTool('wait_for_tasks', { taskIds: [t1.taskId, t2.taskId], timeoutSec: 30 })).text
        );
        if (!r.still_running.length && !r.questions.length) break;
      }
      await api.callTool('complete_task', {
        taskId: taskIdIn(content),
        summary: 'Login page and auth API implemented',
      });
    })(),

  implementer: (content, _s, api) =>
    (async () => {
      if (!content.startsWith('[Crewtree task')) return api.text('ok');
      const file = content.includes('Auth API') ? 'src/auth/service.ts' : 'src/pages/Login.tsx';
      await api.useTool('Edit', { file_path: file, old_string: 'a', new_string: 'b' });
      await api.useTool('Edit', { file_path: file, old_string: 'b', new_string: 'c' });
      await api.callTool('complete_task', { taskId: taskIdIn(content), summary: `Edited ${file}`, files: [file] });
    })(),
};
const leadNotes: { spawnDenied?: string; overlap?: string } = {};
let analystTask = '';

const sessions = SessionService.getInstance();
let events: AgentEvent[] = [];
let cwd: string;

beforeAll(() => {
  writeAgent('researcher', { model: 'haiku', tools: 'Read, Grep, Glob' });
  writeAgent('analyst', { model: 'haiku', tools: 'Read, Grep, Glob' });
  writeAgent('lead-coder', {
    model: 'haiku',
    tools: 'Read, Grep, Glob',
    canDelegate: 'true',
    delegates: '[implementer]',
  });
  writeAgent('implementer', { model: 'haiku', tools: 'Read, Edit, Write' });
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-proj-'));
  sessions.setDriverFactory((agent) => new FakeDriver(scripts[agent.agentName], 2));

  // The user approves edits: first one "always allow" for the agent, so the second needs no prompt
  events = recordEvents();
  const approvals = ApprovalService.getInstance();
  events.push = new Proxy(events.push, {
    apply(target, thisArg, args: AgentEvent[]) {
      for (const e of args) {
        if (e.type === 'approval.created') {
          setTimeout(
            () =>
              approvals.decide(e.payload.id, {
                decision: 'allow',
                rule: 'pattern',
                pattern: e.payload.suggestedPattern,
              }),
            1
          );
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
});

afterAll(async () => {
  sessions.setDriverFactory(undefined);
  await sessions.disposeAll();
});

describe('three-level tree on FakeDriver (PLAN.md 4.4)', () => {
  it('runs the whole flow, closes the root task and completes the session', async () => {
    const { session } = await sessions.createSession({
      title: 'Login feature',
      cwd,
      settings: sessions.resolveSettings({ limits: { maxConcurrentAgents: 2 } }).data!,
      agents: [{ agentName: 'researcher' }, { agentName: 'analyst' }, { agentName: 'lead-coder' }],
    });

    // Track how many agents generate output at the same time
    let running = new Set<string>();
    let maxRunning = 0;
    const off = (e: AgentEvent) => {
      if (e.type !== 'agent.status' || e.sessionId !== session.id) return;
      if (e.payload.status === 'running') running.add(e.sessionAgentId!);
      else running.delete(e.sessionAgentId!);
      maxRunning = Math.max(maxRunning, running.size);
    };
    const bus = (await import('../src/events/EventBus.js')).EventBus.getInstance();
    bus.on('event', off);

    await sessions.sendUserMessage(session.id, undefined, 'Build the login page + auth API');
    await waitFor(() => sessions.getSession(session.id)!.status === 'completed', 15000, 'session completed');
    bus.off('event', off);
    running = new Set();

    const tasks = sessions.getSessionTasks(session.id);
    const agents = await sessions.getSessionAgents(session.id);
    if (process.env.DEBUG_TREE) {
      const nm = (id?: string | null) => agents.find((a) => a.id === id)?.alias ?? id;
      for (const e of events.filter((x) => x.sessionId === session.id)) {
        if (['agent.text.delta', 'usage.updated'].includes(e.type)) continue;
        const p = e.payload as any;
        console.log(
          nm(e.sessionAgentId),
          e.type,
          JSON.stringify(p.status ?? p.tool ?? p.text ?? p.title ?? p.output ?? '').slice(0, 160)
        );
      }
    }
    const name = (id: string) => agents.find((a) => a.id === id)!.alias;

    // Root task closed by the Supervisor's final answer
    const root = tasks.find((t) => t.isRoot)!;
    expect(root.status).toBe('done');
    expect(root.resultSummary).toContain('Report');

    // Tree: implementers were spawned under lead-coder (depth 2), not elsewhere
    expect(
      agents.filter((a) => a.agentName === 'implementer').map((a) => [a.alias, a.depth, name(a.parentId!)])
    ).toEqual([
      ['impl-1', 2, 'lead-coder'],
      ['impl-2', 2, 'lead-coder'],
    ]);
    expect(leadNotes.spawnDenied).toMatch(/not in the allowed list/);
    expect(leadNotes.overlap).toMatch(/Scope overlaps/);

    // Every delegated task done, summaries flowed up, the question was answered
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]));
    expect(byTitle['Analyse auth']).toMatchObject({
      status: 'done',
      question: 'Which database?',
      answer: 'Use SQLite',
    });
    expect(byTitle['Analyse auth'].resultSummary).toBe('Analysis done: SQLite');
    expect(byTitle['Build login + auth API']).toMatchObject({ status: 'done', completedBy: 'tool' });
    expect(byTitle['Auth API'].parentTaskId).toBe(byTitle['Build login + auth API'].id);
    expect(tasks.filter((t) => t.status !== 'done')).toEqual([]);

    // Approvals: one prompt per implementer, the second edit matched the "always allow" rule
    const approvals = ApprovalService.getInstance()
      .list()
      .filter((a) => a.sessionId === session.id);
    expect(approvals.map((a) => [name(a.sessionAgentId), a.pattern]).sort()).toEqual([
      ['impl-1', 'Edit(src/auth/**)'],
      ['impl-2', 'Edit(src/pages/**)'],
    ]);

    // Files touched recorded per agent/task
    const touches = getDb().select().from(fileTouchesTable).where(eq(fileTouchesTable.sessionId, session.id)).all();
    expect([...new Set(touches.map((t) => `${name(t.sessionAgentId)}:${t.path}`))].sort()).toEqual([
      'impl-1:src/auth/service.ts',
      'impl-2:src/pages/Login.tsx',
    ]);

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(maxRunning).toBeGreaterThanOrEqual(1);
  }, 20000);
});
