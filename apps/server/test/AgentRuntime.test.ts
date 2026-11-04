// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAgent, AgentEvent } from '@crewtree/shared';
import { AgentRuntime, AgentRuntimeOptions, DriverType, LANGUAGE_RULE } from '../src/runtime/AgentRuntime.js';
import { FakeDriver, FakeScenario, echoScenario } from '../src/runtime/drivers/FakeDriver.js';
import { EventBus } from '../src/events/EventBus.js';

const SNAPSHOT = `---
name: coder
description: Writes code
model: sonnet
tools: Read, Edit
---
You are a coder.`;

let counter = 0;
function makeAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: `agent-${++counter}`,
    sessionId: 'sess',
    agentName: 'coder',
    scope: 'project',
    snapshot: SNAPSHOT,
    parentId: null,
    depth: 0,
    spawnedBy: 'user',
    status: 'idle',
    lastActiveAt: Date.now(),
    sdkSessionId: null,
    ...overrides,
  };
}

const runtimes: AgentRuntime[] = [];
function makeRuntime(
  agent: SessionAgent,
  opts: Partial<AgentRuntimeOptions> & { scenario?: FakeScenario } = {}
): { runtime: AgentRuntime; drivers: Array<{ type: DriverType; driver: FakeDriver }> } {
  const drivers: Array<{ type: DriverType; driver: FakeDriver }> = [];
  const runtime = new AgentRuntime({
    sessionId: 'sess',
    sessionAgent: agent,
    cwd: process.cwd(),
    driverType: 'fake',
    driverFactory: (type) => {
      const driver = new FakeDriver(opts.scenario ?? echoScenario, 1);
      drivers.push({ type, driver });
      return driver;
    },
    ...opts,
  });
  runtimes.push(runtime);
  return { runtime, drivers };
}

function collectEvents(sessionAgentId: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  EventBus.getInstance().on('event', (e: AgentEvent) => {
    if (e.sessionAgentId === sessionAgentId) events.push(e);
  });
  return events;
}

async function waitFor(check: () => boolean, ms = 1000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(runtimes.splice(0).map((r) => r.dispose()));
});

describe('AgentRuntime', () => {
  it('builds driver options from the snapshot: body as prompt, frontmatter tools/model, crewtree tools auto-allowed', async () => {
    const { runtime, drivers } = makeRuntime(makeAgent());
    await runtime.start();
    const opts = drivers[0].driver.lastInitOptions!;
    expect(opts.systemPrompt).toBe(`You are a coder.\n\n${LANGUAGE_RULE}`);
    expect(opts.systemPrompt).not.toContain('---');
    expect(opts.tools).toEqual(['Read', 'Edit']);
    expect(opts.allowedTools).toEqual(['mcp__crewtree__*']);
    expect(opts.model).toBe('sonnet');
    expect(opts.mcpServers?.crewtree).toBeDefined();
  });

  it('session model override wins over frontmatter', async () => {
    const { runtime, drivers } = makeRuntime(makeAgent({ modelOverride: 'opus' }));
    await runtime.start();
    expect(drivers[0].driver.lastInitOptions!.model).toBe('opus');
  });

  it('an explicit tools list also blocks MCP tools that are not listed (Claude Code semantics)', async () => {
    const snap = (tools: string) => SNAPSHOT.replace('tools: Read, Edit', `tools: ${tools}`);
    const check = async (tools: string, tool: string) => {
      const { runtime, drivers } = makeRuntime(makeAgent({ snapshot: snap(tools) }));
      await runtime.start();
      return (await drivers[0].driver.lastInitOptions!.hooks!.preToolUse!(tool, {}, 'x')).decision;
    };
    expect(await check('Read, Edit', 'mcp__chrome-devtools__evaluate_script')).toBe('deny');
    expect(await check('Read, Edit', 'mcp__crewtree__delegate_task')).not.toBe('deny');
    expect(await check('Read, mcp__chrome-devtools', 'mcp__chrome-devtools__click')).not.toBe('deny');
    expect(await check('Read, mcp__github__get_issue', 'mcp__github__get_issue')).not.toBe('deny');
    expect(await check('Read, mcp__github__get_issue', 'mcp__github__create_issue')).toBe('deny');
    expect(await check('Read, Edit', 'Read')).not.toBe('deny');
    const inherit = makeRuntime(makeAgent({ snapshot: SNAPSHOT.replace('tools: Read, Edit\n', '') }));
    await inherit.runtime.start();
    expect(
      (await inherit.drivers[0].driver.lastInitOptions!.hooks!.preToolUse!('mcp__chrome-devtools__click', {}, 'x'))
        .decision
    ).not.toBe('deny');
  });

  it('passes the fallback model only when it differs from an explicit model', async () => {
    const a = makeRuntime(makeAgent(), { fallbackModel: 'haiku' });
    await a.runtime.start();
    expect(a.drivers[0].driver.lastInitOptions!.fallbackModel).toBe('haiku');
    const same = makeRuntime(makeAgent(), { fallbackModel: 'sonnet' });
    await same.runtime.start();
    expect(same.drivers[0].driver.lastInitOptions!.fallbackModel).toBeUndefined();
    const inherit = makeRuntime(makeAgent({ snapshot: SNAPSHOT.replace('model: sonnet\n', '') }), {
      fallbackModel: 'haiku',
    });
    await inherit.runtime.start();
    expect(inherit.drivers[0].driver.lastInitOptions!.fallbackModel).toBeUndefined();
  });

  it('logs one Activity notice per turn when the fallback model answers', async () => {
    const agent = makeAgent();
    const events = collectEvents(agent.id);
    const usage = vi.fn();
    const served = (sid: string) => ({
      type: 'assistant',
      session_id: sid,
      parent_tool_use_id: null,
      message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'hi' }] },
    });
    const { runtime } = makeRuntime(agent, {
      fallbackModel: 'haiku',
      onTurnComplete: usage,
      scenario: (_c, sid) => [
        { type: 'system', subtype: 'init', session_id: sid },
        served(sid),
        served(sid),
        { type: 'result', subtype: 'success', session_id: sid, usage: {}, total_cost_usd: 0, num_turns: 1 },
      ],
    });
    await runtime.start();
    await runtime.sendMessage('hello');
    await waitFor(() => usage.mock.calls.length === 1);
    const notices = events.filter((e) => e.type === 'agent.status' && e.payload.modelFallback);
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.modelFallback).toEqual({ from: 'sonnet', to: 'claude-haiku-5-5' });
  });

  it('stays running for the whole turn and goes idle only on the result message', async () => {
    const agent = makeAgent();
    const events = collectEvents(agent.id);
    const usage = vi.fn();
    const { runtime } = makeRuntime(agent, { onTurnComplete: usage });
    await runtime.start();
    expect(runtime.getStatus()).toBe('idle');

    await runtime.sendMessage('hello');
    expect(runtime.getStatus()).toBe('running');
    await waitFor(() => usage.mock.calls.length === 1);

    expect(runtime.getStatus()).toBe('idle');
    const statuses = events.filter((e) => e.type === 'agent.status').map((e) => e.payload.status);
    expect(statuses).toEqual(['running', 'idle']);
    expect(events.some((e) => e.type === 'agent.text.done')).toBe(true);
    expect(usage.mock.calls[0][0]).toMatchObject({ inputTokens: 10, outputTokens: 20 });
    expect(agent.sdkSessionId).toMatch(/^fake-/);
  });

  it('suspends an idle agent and resumes the same runtime session on the next message', async () => {
    const agent = makeAgent();
    const { runtime, drivers } = makeRuntime(agent);
    await runtime.start();
    const sessionAfterStart = agent.sdkSessionId;

    await runtime.suspend();
    expect(runtime.getStatus()).toBe('suspended');
    expect(runtime.getDriver()).toBeUndefined();

    await runtime.sendMessage('back');
    expect(drivers).toHaveLength(2);
    expect(drivers[1].driver.lastInitOptions!.resumeSessionId).toBe(sessionAfterStart ?? undefined);
  });

  it('does not suspend while a turn is running', async () => {
    const { runtime } = makeRuntime(makeAgent());
    await runtime.start();
    await runtime.sendMessage('busy');
    await runtime.suspend();
    expect(runtime.getStatus()).toBe('running');
  });

  it('auto-suspends after idleSuspendMinutes', async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime(makeAgent(), { idleSuspendMinutes: 1 });
    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.getStatus()).toBe('suspended');
  });

  it('applies a new idleSuspendMinutes to a running idle timer', async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime(makeAgent(), { idleSuspendMinutes: 30 });
    await runtime.start();
    runtime.updateSettings({ idleSuspendMinutes: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.getStatus()).toBe('suspended');
  });

  it('freshContextPerTask starts a new runtime session per task but keeps context within a task', async () => {
    const agent = makeAgent({ freshContextOverride: true, sdkSessionId: 'old-session' });
    const { runtime, drivers } = makeRuntime(agent);
    await runtime.start();
    expect(drivers[0].driver.lastInitOptions!.resumeSessionId).toBe('old-session');

    await runtime.sendMessage('follow-up in same task');
    expect(drivers).toHaveLength(1);
    await waitFor(() => runtime.getStatus() === 'idle');

    await runtime.sendMessage('new task', { newTask: true });
    expect(drivers).toHaveLength(2);
    expect(drivers[1].driver.lastInitOptions!.resumeSessionId).toBeUndefined();
  });

  it('only a rejected rate limit throttles, then retries the message with backoff', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scenario: FakeScenario = (content, sid) => {
      calls++;
      if (calls === 1) {
        return [
          { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
          { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, usage: {} },
        ];
      }
      return echoScenario(content, sid);
    };
    const { runtime } = makeRuntime(makeAgent(), { scenario });
    await runtime.start();
    await runtime.sendMessage('hi');
    await vi.advanceTimersByTimeAsync(10);
    expect(runtime.getStatus()).toBe('throttled');

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toBe(2);
    expect(runtime.getStatus()).toBe('idle');
  });

  it('allowed rate limit info does not change status', async () => {
    const scenario: FakeScenario = (content, sid) => [
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      ...echoScenario(content, sid),
    ];
    const agent = makeAgent();
    const events = collectEvents(agent.id);
    const { runtime } = makeRuntime(agent, { scenario });
    await runtime.start();
    await runtime.sendMessage('hi');
    await waitFor(() => runtime.getStatus() === 'idle');
    expect(events.some((e) => e.payload.status === 'throttled')).toBe(false);
  });

  it('marks the agent error when the process dies and restarts it on the next message', async () => {
    let calls = 0;
    const scenario: FakeScenario = (content, sid) =>
      ++calls === 1 ? [{ type: 'crewtree.error', error: 'boom' }] : echoScenario(content, sid);
    const { runtime, drivers } = makeRuntime(makeAgent(), { scenario });
    await runtime.start();
    await runtime.sendMessage('one');
    await waitFor(() => runtime.getStatus() === 'error');
    expect(runtime.getDriver()).toBeUndefined();

    await runtime.sendMessage('two');
    expect(drivers).toHaveLength(2);
    await waitFor(() => runtime.getStatus() === 'idle');
  });

  it('falls back from SDK to CLI when the SDK fails before any output, replaying the message', async () => {
    const drivers: DriverType[] = [];
    const sent: string[] = [];
    const runtime = new AgentRuntime({
      sessionId: 'sess',
      sessionAgent: makeAgent(),
      cwd: process.cwd(),
      driverFactory: (type) => {
        drivers.push(type);
        const scenario: FakeScenario =
          type === 'sdk'
            ? () => [{ type: 'crewtree.error', error: 'not authenticated' }]
            : (content, sid) => {
                sent.push(content);
                return echoScenario(content, sid);
              };
        return new FakeDriver(scenario, 1);
      },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendMessage('hello');
    await waitFor(() => runtime.getStatus() === 'idle' && sent.length === 1);
    expect(drivers).toEqual(['sdk', 'cli']);
    expect(sent).toEqual(['hello']);
  });

  it('interrupt ends the turn', async () => {
    const { runtime } = makeRuntime(makeAgent(), { scenario: () => new Promise<void>(() => {}) });
    await runtime.start();
    await runtime.sendMessage('long task');
    expect(runtime.getStatus()).toBe('running');
    await runtime.interrupt();
    expect(runtime.getStatus()).toBe('idle');
  });
});

describe('concurrency slots', () => {
  it('does not keep a slot when the turn ended while waiting for children (cancel race)', async () => {
    const { ConcurrencyLimiter } = await import('../src/runtime/ConcurrencyLimiter.js');
    const limiter = new ConcurrencyLimiter(() => ({ global: 1, session: 1 }));
    const { runtime } = makeRuntime(makeAgent(), { limiter, scenario: () => new Promise<void>(() => {}) });
    await runtime.start();
    await runtime.sendMessage('long task');
    expect(limiter.runningCount()).toBe(1);

    runtime.enterWaitingChildren(1); // inside wait_for_tasks: slot released
    expect(limiter.runningCount()).toBe(0);
    await runtime.interrupt(); // task cancelled: the turn ends
    await waitFor(() => !runtime.isTurnActive());
    await runtime.leaveWaitingChildren(); // the wait returns afterwards

    expect(limiter.runningCount()).toBe(0);
    expect(runtime.getStatus()).toBe('idle');
  });
});
