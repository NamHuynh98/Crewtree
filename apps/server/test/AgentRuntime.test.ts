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
