// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, Session } from '@crewtree/shared';
import { SessionService } from '../src/sessions/SessionService.js';
import { FakeDriver, FakeScenario, FakeTurnApi } from '../src/runtime/drivers/FakeDriver.js';
import { ApprovalService } from '../src/approvals/ApprovalService.js';
import { createToolHooks } from '../src/runtime/toolHooks.js';
import { FileLockManager } from '../src/files/FileLockManager.js';
import { parse, recordEvents, taskIdIn, waitFor, writeAgent } from './helpers/tree.js';
import { and, eq } from 'drizzle-orm';
import { EventBus } from '../src/events/EventBus.js';
import { closeToolCalls, findOpenToolCalls, SERVER_STOPPED } from '../src/events/toolCalls.js';
import { getDb } from '../src/db/index.js';
import { eventsTable } from '../src/db/schema.js';

const sessions = SessionService.getInstance();
const tm = sessions.taskManager;
let cwd: string;
let events: AgentEvent[];

/** Per-agent-name scripts, replaced by each test. */
let scripts: Record<string, FakeScenario> = {};
const seen: Record<string, string[]> = {};

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

beforeAll(() => {
  writeAgent('worker', { model: 'haiku', tools: 'Read, Edit' });
  writeAgent('lead', { model: 'haiku', canDelegate: 'true', delegates: '[worker]' });
  writeAgent('plain', { model: 'haiku' });
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-tm-'));
  sessions.setDriverFactory(
    (agent) =>
      new FakeDriver((content, sid, api) => {
        (seen[agent.alias || agent.agentName] ??= []).push(content);
        const script = scripts[agent.alias || agent.agentName] ?? scripts[agent.agentName];
        return script ? script(content, sid, api) : api.text('ok');
      }, 2)
  );
  events = recordEvents();
});

const created: string[] = [];

// Hanging fake agents hold machine-wide concurrency slots: stop every session a test created
afterEach(async () => {
  for (const id of created.splice(0)) await sessions.stopSession(id);
});

beforeEach(() => {
  scripts = {};
  for (const k of Object.keys(seen)) delete seen[k];
});

afterAll(async () => {
  sessions.setDriverFactory(undefined);
  await sessions.disposeAll();
});

async function newSession(
  agents: Array<{ agentName: string; alias?: string; parent?: string }>,
  settings: object = {}
) {
  const { session, agents: tree } = await sessions.createSession({
    title: 't',
    cwd,
    settings: sessions.resolveSettings(settings).data!,
    agents,
  });
  created.push(session.id);
  const id = (alias: string) => tree.find((a) => (a.alias || a.agentName) === alias)!.id;
  return { session, id };
}

/** The Supervisor delegates one task to `child` then waits for it (looping on timeouts). */
const delegateAndWait =
  (child: string, extra: Record<string, unknown> = {}): FakeScenario =>
  (content, _s, api) =>
    (async () => {
      if (content.startsWith('[Crewtree')) return api.text('noted');
      const team = parse((await api.callTool('list_agents')).text);
      const t = parse(
        (
          await api.callTool('delegate_task', {
            agentId: team.find((a: any) => a.name === child).agentId,
            title: 'Do it',
            instructions: 'Please do it',
            ...extra,
          })
        ).text
      );
      for (;;) {
        const r = parse((await api.callTool('wait_for_tasks', { taskIds: [t.taskId], timeoutSec: 30 })).text);
        if (!r.still_running.length && !r.questions.length) break;
      }
      await api.text('All done');
    })();

const statusOf = (s: Session) => sessions.getSession(s.id)!.status;

describe('task end rule (PLAN.md 4.2)', () => {
  it('nudges once, then auto-completes with the last answer', async () => {
    scripts['crewtree-supervisor'] = delegateAndWait('worker');
    scripts.worker = (content, _s, api) =>
      api.text(content.startsWith('[Crewtree]') ? 'Final answer: 42' : 'Working on it');
    const { session } = await newSession([{ agentName: 'worker' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(() => statusOf(session) === 'completed', 5000, 'completed');

    const task = sessions.getSessionTasks(session.id).find((t) => !t.isRoot)!;
    expect(task).toMatchObject({ status: 'done', completedBy: 'auto', resultSummary: 'Final answer: 42' });
    expect(seen.worker[1]).toMatch(/Call complete_task/);
  });
});

describe('messages to busy agents (PLAN.md 4.3)', () => {
  it('queues a second message until the turn ends; interrupt delivers right away', async () => {
    const g = gate();
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      (async () => {
        if (content === 'first') await g.promise;
        await api.text(`handled ${content}`);
      })();
    const { session } = await newSession([]);
    await sessions.sendUserMessage(session.id, undefined, 'first');
    const second = await sessions.sendUserMessage(session.id, undefined, 'second');
    expect(second.delivery).toBe('queued');
    expect(seen['Supervisor']).toEqual(['first']);
    g.open();
    await waitFor(() => (seen['Supervisor'] ?? []).length === 2, 3000, 'second delivered');
    expect(seen['Supervisor'][1]).toBe('second');
    expect(events.some((e) => e.type === 'message.updated' && e.payload.messageId === second.messageId)).toBe(true);

    // Interrupt & send
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      content === 'slow' ? new Promise<void>(() => {}) : api.text(`handled ${content}`);
    await waitFor(() => !sessions.peekRuntime(session.supervisorAgentId)!.isTurnActive(), 3000, 'idle');
    await sessions.sendUserMessage(session.id, undefined, 'slow');
    await waitFor(() => (seen['Supervisor'] ?? []).includes('slow'), 3000, 'slow started');
    const urgent = await sessions.sendUserMessage(session.id, undefined, 'urgent', 'interrupt');
    await waitFor(() => (seen['Supervisor'] ?? []).includes('urgent'), 3000, 'urgent delivered');
    expect(urgent.messageId).toBeTruthy();
  });
});

describe('Supervisor asks the user (PLAN.md 4.3)', () => {
  it('root task needs input; the next chat message is the answer', async () => {
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      (async () => {
        if (content.startsWith('[Crewtree] Answer')) return api.text(`Thanks: ${content.split('\n')[1]}`);
        await api.callTool('ask_parent', { question: 'Which framework?' });
      })();
    const { session } = await newSession([]);
    await sessions.sendUserMessage(session.id, undefined, 'Build it');
    await waitFor(() => sessions.getSessionTasks(session.id)[0]?.status === 'needs_input', 3000, 'needs_input');
    expect(sessions.peekRuntime(session.supervisorAgentId)!.getStatus()).toBe('needs_input');
    expect(events.some((e) => e.sessionId === session.id && e.type === 'session.status' && e.payload.needsInput)).toBe(
      true
    );

    await sessions.sendUserMessage(session.id, undefined, 'React');
    await waitFor(() => statusOf(session) === 'completed', 3000, 'completed');
    const root = sessions.getSessionTasks(session.id)[0];
    expect(root).toMatchObject({ status: 'done', answer: 'React', resultSummary: 'Thanks: React' });
    expect(sessions.getSessionTasks(session.id)).toHaveLength(1); // the answer did not start a new root task
  });
});

describe('cancellation cascades down the branch (PLAN.md 4.2)', () => {
  it('cancelling the lead task cancels its children and interrupts them', async () => {
    scripts['crewtree-supervisor'] = delegateAndWait('lead');
    scripts.lead = (content, _s, api) =>
      (async () => {
        if (!content.startsWith('[Crewtree task')) return api.text('ok');
        const w = parse((await api.callTool('spawn_agent', { agentName: 'worker' })).text);
        const t = parse(
          (await api.callTool('delegate_task', { agentId: w.agentId, title: 'Sub', instructions: 'x' })).text
        );
        await api.callTool('wait_for_tasks', { taskIds: [t.taskId], timeoutSec: 600 });
      })();
    scripts.worker = () => new Promise<void>(() => {}); // never finishes
    const { session } = await newSession([{ agentName: 'lead' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(
      () => sessions.getSessionTasks(session.id).some((t) => t.title === 'Sub' && t.status === 'running'),
      3000,
      'sub running'
    );

    const leadTask = sessions.getSessionTasks(session.id).find((t) => t.title === 'Do it')!;
    expect(sessions.cancelTask(session.id, leadTask.id, 'changed my mind')).toBe(2);
    const tasks = sessions.getSessionTasks(session.id);
    expect(tasks.find((t) => t.title === 'Sub')!.status).toBe('cancelled');
    expect(tasks.find((t) => t.title === 'Do it')!.resultSummary).toBe('Cancelled: changed my mind');
    const worker = (await sessions.getSessionAgents(session.id)).find((a) => a.agentName === 'worker')!;
    await waitFor(() => !sessions.peekRuntime(worker.id)!.isTurnActive(), 3000, 'worker interrupted');
  });
});

describe('stale tool calls are fenced by task ID', () => {
  it('a call naming a cancelled task cannot touch the next task', async () => {
    const results: Record<string, { text: string; isError: boolean }> = {};
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      (async () => {
        if (content.startsWith('[Crewtree')) return api.text('noted');
        const team = parse((await api.callTool('list_agents')).text);
        for (const title of ['First', 'Second']) {
          const t = parse(
            (await api.callTool('delegate_task', { agentId: team[0].agentId, title, instructions: 'x' })).text
          );
          await api.callTool('wait_for_tasks', { taskIds: [t.taskId], timeoutSec: 30 });
        }
        await api.text('All done');
      })();
    let firstTask = '';
    scripts.worker = (content, _s, api) => {
      if (!firstTask) {
        firstTask = taskIdIn(content);
        return new Promise<void>(() => {}); // busy until cancelled
      }
      return (async () => {
        results.notice = { text: content, isError: false };
        results.stale = await api.callTool('complete_task', { taskId: firstTask, summary: 'old result' });
        results.staleProgress = await api.callTool('report_progress', { taskId: firstTask, text: 'old' });
        results.noId = await api.callTool('complete_task', { summary: 'no id' });
        results.current = await api.callTool('complete_task', { taskId: taskIdIn(content), summary: 'new result' });
      })();
    };
    const { session } = await newSession([{ agentName: 'worker' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(
      () => sessions.getSessionTasks(session.id).some((t) => t.title === 'First' && t.status === 'running'),
      3000,
      'first running'
    );
    const first = sessions.getSessionTasks(session.id).find((t) => t.title === 'First')!;
    sessions.cancelTask(session.id, first.id, 'wrong plan');
    await waitFor(() => statusOf(session) === 'completed', 5000, 'completed');

    const second = sessions.getSessionTasks(session.id).find((t) => t.title === 'Second')!;
    expect(results.notice.text).toMatch(
      new RegExp(`^\\[Crewtree\\] Your previous task ${first.id} "First" was cancelled`)
    );
    expect(results.stale).toMatchObject({ isError: true });
    expect(results.stale.text).toContain(`Task ${first.id} is cancelled and closed`);
    expect(results.stale.text).toContain(`Your current task is ${second.id}`);
    expect(results.staleProgress.isError).toBe(true);
    expect(results.noId.isError).toBe(true);
    expect(results.noId.text).toMatch(/needs the taskId/);
    expect(results.current.isError).toBe(false);
    expect(second).toMatchObject({ status: 'done', resultSummary: 'new result', progress: null });
    expect(sessions.getSessionTasks(session.id).find((t) => t.id === first.id)!.resultSummary).toBe(
      'Cancelled: wrong plan'
    );
  });

  it('report_progress with no active task is an error, not a silent success', () => {
    const r = () => tm.reportProgress('no-such-agent', { taskId: 'x', text: 'hi' });
    expect(r).toThrow(/not assigned to you/);
    expect(() => tm.reportProgress('no-such-agent', { text: 'hi' })).toThrow(/no active task/);
  });
});

describe('tool calls that never get a result', () => {
  it('cancelling a waiting agent closes its open wait_for_tasks call', async () => {
    scripts['crewtree-supervisor'] = delegateAndWait('worker');
    scripts.worker = () => new Promise<void>(() => {}); // never finishes
    const { session } = await newSession([{ agentName: 'worker' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(
      () => sessions.getSessionTasks(session.id).some((t) => !t.isRoot && t.status === 'running'),
      3000,
      'worker running'
    );
    const supervisor = sessions.getSession(session.id)!.supervisorAgentId!;
    const wait = () =>
      events.find(
        (e) =>
          e.sessionAgentId === supervisor &&
          e.type === 'agent.tool.start' &&
          (e.payload as any).tool === 'mcp__crewtree__wait_for_tasks'
      );
    await waitFor(() => !!wait(), 3000, 'supervisor waiting');
    const toolUseId = (wait()!.payload as any).toolUseId;

    // Interrupt the Supervisor mid-call (as Interrupt & send does)
    await sessions.peekRuntime(supervisor)!.interrupt();
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.type === 'agent.tool.end' && (e.payload as any).toolUseId === toolUseId && (e.payload as any).interrupted
        ),
      3000,
      'wait_for_tasks closed'
    );
    expect(findOpenToolCalls().filter((c) => c.sessionId === session.id && c.sessionAgentId === supervisor)).toEqual(
      []
    );
  });

  it('after a crash, open tool calls in the database are closed and their start is marked', async () => {
    const { session, id } = await newSession([{ agentName: 'worker' }]);
    const worker = id('worker');
    // What a crashed server leaves: a start with no end
    EventBus.getInstance().emitEvent({
      sessionId: session.id,
      sessionAgentId: worker,
      type: 'agent.tool.start',
      payload: { tool: 'Bash', toolUseId: 'toolu_dead', input: { command: 'sleep 60' } },
      ts: Date.now(),
    });
    EventBus.getInstance().emitEvent({
      sessionId: session.id,
      sessionAgentId: worker,
      type: 'agent.tool.start',
      payload: { tool: 'Read', toolUseId: 'toolu_done', input: {} },
      ts: Date.now(),
    });
    EventBus.getInstance().emitEvent({
      sessionId: session.id,
      sessionAgentId: worker,
      type: 'agent.tool.end',
      payload: { toolUseId: 'toolu_done', output: 'ok', isError: false },
      ts: Date.now(),
    });
    const open = findOpenToolCalls().filter((c) => c.sessionId === session.id);
    expect(open.map((c) => c.toolUseId)).toEqual(['toolu_dead']);

    closeToolCalls(open, SERVER_STOPPED);
    expect(findOpenToolCalls().filter((c) => c.sessionId === session.id)).toEqual([]);
    const stored = getDb()
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionAgentId, worker), eq(eventsTable.type, 'agent.tool.start')))
      .all()
      .map((e) => JSON.parse(e.payload));
    // The start itself says so: a chat page that holds it but not the end still shows it closed
    expect(stored.find((p) => p.toolUseId === 'toolu_dead')).toMatchObject({ interrupted: true });
    expect(stored.find((p) => p.toolUseId === 'toolu_done').interrupted).toBeUndefined();
    expect(
      events.find((e) => e.type === 'agent.tool.end' && (e.payload as any).toolUseId === 'toolu_dead')?.payload
    ).toMatchObject({ isError: true, interrupted: true, output: SERVER_STOPPED });
  });
});

describe('server restart mid-task (PLAN.md 20)', () => {
  it('interrupts the branch, tells the parent and the resumed child, and fences the old task', async () => {
    const seenBySupervisor: string[] = [];
    const results: Record<string, { text: string; isError: boolean }> = {};
    let round = 0;
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      (async () => {
        seenBySupervisor.push(content);
        if (content.startsWith('[Crewtree] Task')) return api.text('noted');
        round++;
        const team = parse((await api.callTool('list_agents')).text);
        const t = parse(
          (
            await api.callTool('delegate_task', {
              agentId: team[0].agentId,
              title: round === 1 ? 'Research' : 'Research again',
              instructions: 'x',
            })
          ).text
        );
        await api.callTool('wait_for_tasks', { taskIds: [t.taskId], timeoutSec: 600 });
        await api.text('All done');
      })();
    let oldTask = '';
    scripts.worker = (content, _s, api) => {
      if (!oldTask) {
        oldTask = taskIdIn(content);
        return api.callTool('report_progress', { taskId: oldTask, text: 'compared 3 of 5 libs' }).then(
          () => new Promise<void>(() => {}) // still working when the server dies
        );
      }
      return (async () => {
        results.notice = { text: content, isError: false };
        results.stale = await api.callTool('complete_task', { taskId: oldTask, summary: 'stale' });
        results.current = await api.callTool('complete_task', { taskId: taskIdIn(content), summary: 'fresh' });
      })();
    };
    const { session } = await newSession([{ agentName: 'worker' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(
      () => sessions.getSessionTasks(session.id).some((t) => t.progress === 'compared 3 of 5 libs'),
      3000,
      'worker busy'
    );

    // "kill -9": every process is gone and in-memory state is lost; the new server reconciles the database
    await sessions.disposeAll();
    (tm as any).waits.clear();
    (sessions as any).reconcileAfterRestart();
    const afterRestart = sessions.getSessionTasks(session.id);
    expect(afterRestart.map((t) => t.status)).toEqual(['interrupted', 'interrupted']);
    const [rootTask, research] = afterRestart;

    await sessions.sendUserMessage(session.id, undefined, 'continue');
    await waitFor(() => statusOf(session) === 'completed', 5000, 'completed');

    const resumed = seenBySupervisor.at(-1)!;
    expect(resumed).toContain(`Your previous task ${rootTask.id} "go" was interrupted by a Crewtree server restart`);
    expect(resumed).toContain(
      `- worker · ${research.id} "Research": interrupted (last progress: compared 3 of 5 libs)`
    );
    expect(resumed.endsWith('continue')).toBe(true);

    expect(results.notice.text).toMatch(
      new RegExp(`^\\[Crewtree\\] Your previous task ${research.id} "Research" was interrupted`)
    );
    expect(results.stale.isError).toBe(true);
    expect(results.stale.text).toContain(`Task ${research.id} is interrupted and closed`);
    expect(results.current.isError).toBe(false);
    const tasks = sessions.getSessionTasks(session.id);
    expect(tasks.find((t) => t.id === research.id)!.status).toBe('interrupted');
    expect(tasks.find((t) => t.title === 'Research again')).toMatchObject({ status: 'done', resultSummary: 'fresh' });
  });
});

describe('wait_for_tasks', () => {
  it('releases the slot while waiting, times out, then queues for a slot to continue', async () => {
    let waitResult: any;
    scripts['crewtree-supervisor'] = (_content, _s, api) =>
      (async () => {
        const team = parse((await api.callTool('list_agents')).text);
        const t = parse(
          (await api.callTool('delegate_task', { agentId: team[0].agentId, title: 'Slow', instructions: 'x' })).text
        );
        waitResult = parse((await api.callTool('wait_for_tasks', { taskIds: [t.taskId], timeoutSec: 1 })).text);
      })();
    scripts.worker = () => new Promise<void>(() => {});
    const { session } = await newSession([{ agentName: 'worker' }], { limits: { maxConcurrentAgents: 1 } });
    await sessions.sendUserMessage(session.id, undefined, 'go');

    // With a single slot the worker can only run because the waiting Supervisor released it
    const slow = () => sessions.getSessionTasks(session.id).find((t) => t.title === 'Slow');
    const supervisor = sessions.peekRuntime(session.supervisorAgentId)!;
    await waitFor(() => supervisor.getStatus() === 'waiting_children', 3000, 'supervisor waiting');
    const workerRuntime = () => sessions.peekRuntime(slow()!.toAgentId);
    await waitFor(() => workerRuntime()?.getStatus() === 'running', 3000, 'worker running');
    expect(sessions.limiter.runningCount(session.id)).toBe(1);

    // Timeout: the Supervisor wants to continue but the worker holds the only slot
    await waitFor(() => supervisor.getStatus() === 'queued', 3000, 'supervisor queued');
    expect(waitResult).toBeUndefined();

    sessions.cancelTask(session.id, slow()!.id);
    await waitFor(() => waitResult !== undefined, 3000, 'wait returned');
    // The result reflects the state when the Supervisor got its slot back
    expect(waitResult).toMatchObject({ timed_out: true, still_running: [] });
    expect(waitResult.completed).toMatchObject([{ agent: 'worker', status: 'cancelled' }]);
  });
});

describe('stop session', () => {
  it('cancels every task and interrupts running agents', async () => {
    scripts['crewtree-supervisor'] = delegateAndWait('worker');
    scripts.worker = () => new Promise<void>(() => {});
    const { session } = await newSession([{ agentName: 'worker' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(
      () => sessions.getSessionTasks(session.id).some((t) => !t.isRoot && t.status === 'running'),
      3000,
      'running'
    );
    await sessions.stopSession(session.id);
    expect(statusOf(session)).toBe('stopped');
    expect(sessions.getSessionTasks(session.id).map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('tree limits (PLAN.md 4.2, 4.3)', () => {
  it('enforces canDelegate, delegates, maxDepth and maxTotalAgents', async () => {
    const { session, id } = await newSession([{ agentName: 'lead' }, { agentName: 'plain' }], {
      limits: { maxDepth: 3, maxTotalAgents: 4 },
    });
    await expect(sessions.addAgent(session.id, { agentName: 'worker', parentId: id('plain') })).rejects.toThrow(
      /cannot delegate/
    );
    await expect(sessions.addAgent(session.id, { agentName: 'plain', parentId: id('lead') })).rejects.toThrow(
      /allowed list/
    );
    const w = await sessions.addAgent(session.id, { agentName: 'worker', parentId: id('lead') });
    expect(w.depth).toBe(2);
    await expect(sessions.addAgent(session.id, { agentName: 'worker' })).rejects.toThrow(/maxTotalAgents 4/);
    await expect(sessions.addAgent(session.id, { agentName: 'nope' })).rejects.toThrow();

    const deep = await newSession([{ agentName: 'lead' }], { limits: { maxDepth: 2 } });
    await expect(
      sessions.addAgent(deep.session.id, { agentName: 'worker', parentId: deep.id('lead') })
    ).rejects.toThrow(/maxDepth 2/);
  });

  it('rejects overlapping scopes between branches', async () => {
    let second: { text: string; isError: boolean } | undefined;
    const g = gate();
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      (async () => {
        if (content.startsWith('[Crewtree')) return;
        const team = parse((await api.callTool('list_agents')).text);
        await api.callTool('delegate_task', {
          agentId: team[0].agentId,
          title: 'A',
          instructions: 'x',
          scope: ['src/**'],
        });
        second = await api.callTool('delegate_task', {
          agentId: team[1].agentId,
          title: 'B',
          instructions: 'x',
          scope: ['src/auth/x.ts'],
        });
        await g.promise;
      })();
    scripts.worker = () => new Promise<void>(() => {});
    const { session } = await newSession([{ agentName: 'worker' }, { agentName: 'worker', alias: 'worker-2' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(() => second !== undefined, 3000, 'second delegate');
    expect(second).toMatchObject({ isError: true });
    expect(second!.text).toMatch(/Scope overlaps running task .* "A"/);
    g.open();
    await sessions.stopSession(session.id);
  });
});

describe('file locks and scope in hooks (PLAN.md 5)', () => {
  it(
    'denies an edit locked by another agent and asks for edits outside the task scope',
    { timeout: 20000 },
    async () => {
      let lockedResult: { allowed: boolean; reason?: string } | undefined;
      let outsideResult: { allowed: boolean; reason?: string } | undefined;
      const hold = gate();
      scripts['crewtree-supervisor'] = (content, _s, api) =>
        (async () => {
          if (content.startsWith('[Crewtree')) return;
          const team = parse((await api.callTool('list_agents')).text);
          await api.callTool('delegate_task', {
            agentId: team[0].agentId,
            title: 'Own',
            instructions: 'x',
            scope: ['src/a/**'],
          });
          await api.callTool('delegate_task', {
            agentId: team[1].agentId,
            title: 'Other',
            instructions: 'x',
            scope: ['src/b/**'],
          });
          await hold.promise;
        })();
      scripts.worker = (_c, _s, api: FakeTurnApi) =>
        (async () => {
          await api.useTool('Edit', { file_path: 'src/a/shared.ts' });
          await hold.promise;
        })();
      scripts['worker-2'] = (_c, _s, api: FakeTurnApi) =>
        (async () => {
          // Deterministic: edit only once worker really holds the lease (CI runners are slow)
          await waitFor(
            () => !!FileLockManager.getInstance().holderOf(path.resolve(cwd, 'src/a/shared.ts')),
            8000,
            'lease held'
          );
          lockedResult = await api.useTool('Edit', { file_path: 'src/a/shared.ts' });
          outsideResult = await api.useTool('Edit', { file_path: 'docs/notes.md' });
          await hold.promise;
        })();

      const approvals = ApprovalService.getInstance();
      const decided: string[] = [];
      const onEvent = (e: AgentEvent) => {
        if (e.type === 'approval.created') {
          decided.push(e.payload.label ?? 'normal');
          setTimeout(
            () =>
              approvals.decide(e.payload.id, {
                decision: e.payload.label ? 'deny' : 'allow',
                rule: 'once',
                reason: 'stay in scope',
              }),
            1
          );
        }
      };
      const bus = (await import('../src/events/EventBus.js')).EventBus.getInstance();
      bus.on('event', onEvent);
      const { session } = await newSession([{ agentName: 'worker' }, { agentName: 'worker', alias: 'worker-2' }]);
      await sessions.sendUserMessage(session.id, undefined, 'go');
      try {
        await waitFor(() => outsideResult !== undefined, 12000, 'worker-2 done');
      } finally {
        if (process.env.DEBUG_TREE) {
          const agents = await sessions.getSessionAgents(session.id);
          const nm = (x?: string | null) => agents.find((a) => a.id === x)?.alias ?? x;
          for (const e of events.filter(
            (x) => x.sessionId === session.id && !['agent.text.delta', 'usage.updated'].includes(x.type)
          )) {
            const p = e.payload as any;
            console.log(
              'DBG',
              nm(e.sessionAgentId),
              e.type,
              JSON.stringify(p.status ?? p.tool ?? p.label ?? p.output ?? p.title ?? '').slice(0, 140)
            );
          }
        }
      }
      bus.off('event', onEvent);

      expect(lockedResult).toMatchObject({ allowed: false });
      expect(lockedResult!.reason).toMatch(/src\/a\/shared.ts is locked by worker/);
      expect(
        events.some((e) => e.sessionId === session.id && e.type === 'file.conflict' && e.payload.holder === 'worker')
      ).toBe(true);
      expect(outsideResult).toEqual({ allowed: false, reason: 'stay in scope' });
      expect(decided).toEqual(['normal', 'outside_scope']);
      hold.open();
      await sessions.stopSession(session.id);
    }
  );

  it('hooks: no scope restriction for direct user chats', async () => {
    const { session, id } = await newSession([{ agentName: 'worker' }]);
    const hooks = createToolHooks({
      sessionId: session.id,
      agent: (await sessions.getSessionAgents(session.id)).find((a) => a.id === id('worker'))!,
      cwd,
      taskManager: tm,
    });
    expect(await hooks.preToolUse!('Edit', { file_path: 'anything.ts' }, 'tu1')).toEqual({});
  });
});

describe('maxTokens per session (PLAN.md 4.3)', () => {
  it('pauses the session once the budget is used', async () => {
    const { session } = await newSession([], { limits: { maxTokens: 20 } });
    await sessions.sendUserMessage(session.id, undefined, 'one');
    await waitFor(() => statusOf(session) !== 'active', 3000, 'paused');
    expect(statusOf(session)).toBe('paused');
    await expect(sessions.sendUserMessage(session.id, undefined, 'two')).rejects.toThrow(/Token budget reached/);
    expect(
      events.some((e) => e.sessionId === session.id && e.type === 'session.status' && e.payload.reason === 'maxTokens')
    ).toBe(true);
  });
});

describe('user_interventions (PLAN.md 4.3)', () => {
  it('tells the parent when the user chats with its child', async () => {
    let waitResult: any;
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      (async () => {
        if (content.startsWith('[Crewtree')) return;
        const team = parse((await api.callTool('list_agents')).text);
        const t = parse(
          (await api.callTool('delegate_task', { agentId: team[0].agentId, title: 'Job', instructions: 'x' })).text
        );
        waitResult = parse((await api.callTool('wait_for_tasks', { taskIds: [t.taskId], timeoutSec: 30 })).text);
      })();
    scripts.worker = (content, _s, api) =>
      content.startsWith('[Crewtree task') ? new Promise<void>(() => {}) : api.text('ok');
    const { session, id } = await newSession([{ agentName: 'worker' }]);
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(
      () => sessions.peekRuntime(session.supervisorAgentId)?.getStatus() === 'waiting_children',
      3000,
      'waiting'
    );

    await sessions.sendUserMessage(session.id, id('worker'), 'Please add refresh tokens too');
    await waitFor(() => waitResult !== undefined, 3000, 'wait returned');
    expect(waitResult.user_interventions).toEqual([{ agent: 'worker', message: 'Please add refresh tokens too' }]);
    expect(waitResult.timed_out).toBe(false);
  });
});

describe('changes made through Bash (PLAN.md 5.3)', () => {
  it('attributes files changed while an agent runs Bash, and others to unknown', async () => {
    const { FileActivity } = await import('../src/files/FileActivity.js');
    const { getDb } = await import('../src/db/index.js');
    const { fileTouchesTable } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-bash-'));
    const activity = FileActivity.getInstance();
    activity.watchSession('bash-session', dir);
    await new Promise((r) => setTimeout(r, 300)); // watcher ready

    activity.bashStarted('bash-session', 'agent-1', 'task-1');
    fs.writeFileSync(path.join(dir, 'generated.txt'), 'x');
    await new Promise((r) => setTimeout(r, 600));
    activity.bashEnded('agent-1');
    await new Promise((r) => setTimeout(r, 1700)); // past the grace period
    fs.writeFileSync(path.join(dir, 'by-someone.txt'), 'y');

    const rows = () =>
      getDb().select().from(fileTouchesTable).where(eq(fileTouchesTable.sessionId, 'bash-session')).all();
    await waitFor(() => rows().length >= 2, 4000, 'touches recorded');
    await activity.unwatchSession('bash-session');
    expect(
      rows()
        .map((r) => [r.path, r.op, r.sessionAgentId, r.taskId])
        .sort()
    ).toEqual([
      ['by-someone.txt', 'unknown', '', null],
      ['generated.txt', 'bash', 'agent-1', 'task-1'],
    ]);
  }, 10000);

  it('reports a Bash change to a file another agent holds as a conflict', async () => {
    const { FileActivity } = await import('../src/files/FileActivity.js');
    const { EventBus } = await import('../src/events/EventBus.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-bash-lock-'));
    const file = path.join(dir, 'shared.ts');
    fs.writeFileSync(file, 'a');
    const locks = FileLockManager.getInstance();
    locks.acquire(file, { sessionId: 'lock-session', sessionAgentId: 'holder', agentName: 'coder-a', taskTitle: 'A' });
    const conflicts: AgentEvent[] = [];
    const onEvent = (e: AgentEvent) => e.type === 'file.conflict' && conflicts.push(e);
    EventBus.getInstance().on('event', onEvent);
    const activity = FileActivity.getInstance();
    activity.watchSession('lock-session', dir);
    await new Promise((r) => setTimeout(r, 300));

    activity.bashStarted('lock-session', 'intruder');
    fs.writeFileSync(file, 'b');
    await waitFor(() => conflicts.length > 0, 4000, 'conflict reported');
    activity.bashEnded('intruder');
    await activity.unwatchSession('lock-session');
    EventBus.getInstance().off('event', onEvent);
    locks.releaseAgent('holder');
    expect(conflicts[0].payload).toMatchObject({
      path: 'shared.ts',
      agentId: 'intruder',
      holderAgentId: 'holder',
      holderTask: 'A',
      via: 'Bash',
    });
  }, 10000);
});

describe('no redundant notices (found in the real 3-level run)', () => {
  it('a child result already returned by wait_for_tasks does not wake the parent again', async () => {
    scripts['crewtree-supervisor'] = (content, _s, api) =>
      (async () => {
        if (content.startsWith('[Crewtree')) return api.text('extra turn');
        const team = parse((await api.callTool('list_agents')).text);
        const t = parse(
          (await api.callTool('delegate_task', { agentId: team[0].agentId, title: 'Quick', instructions: 'x' })).text
        );
        // The child finishes while the parent is still busy (not waiting) → a notice is queued
        await waitFor(
          () => sessions.getSessionTasks(sessionId).find((x) => x.id === t.taskId)?.status === 'done',
          3000,
          'child done'
        );
        await api.callTool('wait_for_tasks', { taskIds: [t.taskId], timeoutSec: 5 });
        await api.text('Final report');
      })();
    scripts.worker = (c, _s, api) =>
      api.callTool('complete_task', { taskId: taskIdIn(c), summary: 'quick done' }).then(() => undefined);
    const { session } = await newSession([{ agentName: 'worker' }]);
    sessionId = session.id;
    await sessions.sendUserMessage(session.id, undefined, 'go');
    await waitFor(() => statusOf(session) === 'completed', 4000, 'completed');
    await new Promise((r) => setTimeout(r, 100));
    expect(seen['Supervisor']).toEqual(['go']);
  });
});
let sessionId = '';
