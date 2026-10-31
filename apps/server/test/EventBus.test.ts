// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { EventBus, WsSocket } from '../src/events/EventBus.js';

function mockSocket(): WsSocket & { received: any[] } {
  const received: any[] = [];
  return { readyState: 1, send: (data: string) => received.push(JSON.parse(data)), on: () => {}, received };
}

const bus = EventBus.getInstance();
const delta = (sessionId: string, text: string) =>
  bus.emitEvent({ sessionId, sessionAgentId: 'a1', type: 'agent.text.delta', payload: { text }, ts: Date.now() });

describe('EventBus', () => {
  it('batches text deltas (~50ms) and does not persist them', async () => {
    const ws = mockSocket();
    bus.registerClient(ws, 'batch');
    delta('batch', 'Hello ');
    delta('batch', 'World');
    expect(ws.received).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 70));
    expect(ws.received).toHaveLength(1);
    expect(ws.received[0].payload.text).toBe('Hello World');
    expect(bus.getEventsAfter('batch', 0)).toHaveLength(0);
  });

  it('flushes pending deltas before any other event so order is preserved', () => {
    const ws = mockSocket();
    bus.registerClient(ws, 'order');
    delta('order', 'partial');
    bus.emitEvent({ sessionId: 'order', sessionAgentId: 'a1', type: 'usage.updated', payload: {}, ts: Date.now() });
    expect(ws.received.map((e) => e.type)).toEqual(['agent.text.delta', 'usage.updated']);
  });

  it('persists events with increasing ids for replay', () => {
    const first = bus.emitEvent({
      sessionId: 'replay',
      type: 'agent.status',
      payload: { status: 'running' },
      ts: Date.now(),
    });
    const second = bus.emitEvent({
      sessionId: 'replay',
      type: 'agent.status',
      payload: { status: 'idle' },
      ts: Date.now(),
    });
    expect(second.id).toBeGreaterThan(first.id!);
    const missed = bus.getEventsAfter('replay', first.id!);
    expect(missed.map((e) => e.payload.status)).toEqual(['idle']);
  });

  it('sends only global events to clients without a session', () => {
    const global = mockSocket();
    const other = mockSocket();
    bus.registerClient(global);
    bus.registerClient(other, 'other-session');
    bus.emitEvent({ sessionId: 's-x', type: 'agent.status', payload: { status: 'running' }, ts: Date.now() });
    bus.emitEvent({ sessionId: 's-x', type: 'session.status', payload: { status: 'active' }, ts: Date.now() });
    expect(global.received.map((e) => e.type)).toEqual(['session.status']);
    expect(other.received.map((e) => e.type)).toEqual(['session.status']);
  });
});
