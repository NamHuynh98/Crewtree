// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'events';
import { AgentEvent } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { eventsTable } from '../db/schema.js';
import { gt, lt, and, eq, asc, desc } from 'drizzle-orm';

export interface WsSocket {
  readyState: number;
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

/** Events also sent to clients without a session (header, sidebar) — PLAN.md 15.2. */
const GLOBAL_EVENT_PREFIXES = ['approval.', 'resource.changed', 'session.status'];

export function isGlobalEvent(type: string): boolean {
  return GLOBAL_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

interface DeltaBuffer {
  text: string;
  sessionId: string;
  sessionAgentId: string;
  ts: number;
}

export class EventBus extends EventEmitter {
  private static instance: EventBus;
  private wsClients = new Set<{ ws: WsSocket; sessionId?: string }>();
  private deltaBuffer = new Map<string, DeltaBuffer>();
  private deltaFlushTimer?: NodeJS.Timeout;

  private constructor() {
    super();
    this.setMaxListeners(100);
  }

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public registerClient(ws: WsSocket, sessionId?: string) {
    const client = { ws, sessionId };
    this.wsClients.add(client);
    const remove = () => this.wsClients.delete(client);
    ws.on('close', remove);
    ws.on('error', remove);
  }

  public updateClientSession(ws: WsSocket, sessionId: string) {
    for (const client of this.wsClients) {
      if (client.ws === ws) {
        client.sessionId = sessionId;
        break;
      }
    }
  }

  public emitEvent(event: AgentEvent): AgentEvent {
    const db = getDb();
    let savedEventId: number | undefined;

    // Flush pending deltas before any other event so clients see them in order
    if (event.type !== 'agent.text.delta') {
      this.flushDeltas();
    }

    // Buffer text deltas — send in ~50ms batches to reduce WS pressure
    if (event.type === 'agent.text.delta') {
      const key = event.sessionAgentId ?? event.sessionId ?? 'global';
      const existing = this.deltaBuffer.get(key);
      if (existing) {
        existing.text += event.payload?.text || '';
      } else {
        this.deltaBuffer.set(key, {
          text: event.payload?.text || '',
          sessionId: event.sessionId ?? '',
          sessionAgentId: event.sessionAgentId ?? '',
          ts: event.ts || Date.now(),
        });
      }
      if (!this.deltaFlushTimer) {
        this.deltaFlushTimer = setTimeout(() => this.flushDeltas(), 50);
      }

      // Emit on local node event emitter immediately (for internal listeners)
      this.emit('event', event);
      if (event.sessionId) {
        this.emit(`session:${event.sessionId}`, event);
      }
      return event;
    }

    // Persist to SQLite (except high-frequency text deltas — already returned above)
    try {
      const result = db
        .insert(eventsTable)
        .values({
          sessionId: event.sessionId,
          sessionAgentId: event.sessionAgentId ?? null,
          type: event.type,
          payload: JSON.stringify(event.payload),
          ts: event.ts || Date.now(),
        })
        .run();
      savedEventId = Number(result.lastInsertRowid);
    } catch (err) {
      console.error('Failed to persist event to SQLite:', err);
    }

    const finalEvent: AgentEvent = {
      ...event,
      id: savedEventId,
    };

    // Emit on local node event emitter
    this.emit('event', finalEvent);
    if (event.sessionId) {
      this.emit(`session:${event.sessionId}`, finalEvent);
    }

    // Broadcast to WebSocket clients
    this.broadcastWs(finalEvent);

    return finalEvent;
  }

  private flushDeltas() {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer);
      this.deltaFlushTimer = undefined;
    }

    for (const [, buffer] of this.deltaBuffer) {
      const batchedEvent: AgentEvent = {
        sessionId: buffer.sessionId,
        sessionAgentId: buffer.sessionAgentId,
        type: 'agent.text.delta',
        payload: { text: buffer.text },
        ts: buffer.ts,
      };
      this.broadcastWs(batchedEvent);
    }
    this.deltaBuffer.clear();
  }

  private broadcastWs(event: AgentEvent) {
    const payloadStr = JSON.stringify(event);
    for (const client of this.wsClients) {
      // 1 = WebSocket.OPEN (using literal to avoid browser WebSocket global dependency)
      if (client.ws.readyState === 1) {
        // Session clients get their session's events; every client gets global events
        if (client.sessionId === event.sessionId || isGlobalEvent(event.type)) {
          try {
            client.ws.send(payloadStr);
          } catch (e) {
            console.error('Error broadcasting WS event:', e);
          }
        }
      }
    }
  }

  public getEventsAfter(
    sessionId: string,
    lastEventId: number,
    opts: { sessionAgentId?: string; limit?: number } = {}
  ): AgentEvent[] {
    const db = getDb();
    const conditions = [eq(eventsTable.sessionId, sessionId), gt(eventsTable.id, lastEventId)];
    if (opts.sessionAgentId) conditions.push(eq(eventsTable.sessionAgentId, opts.sessionAgentId));
    const query = db
      .select()
      .from(eventsTable)
      .where(and(...conditions))
      .orderBy(asc(eventsTable.id));
    const rows = opts.limit ? query.limit(opts.limit).all() : query.all();

    return rows.map(rowToEvent);
  }

  /** The `limit` most recent events before `beforeId` (oldest first): Activity "Load older". */
  public getEventsBefore(
    sessionId: string,
    beforeId: number,
    opts: { sessionAgentId?: string; limit?: number } = {}
  ): AgentEvent[] {
    const conditions = [eq(eventsTable.sessionId, sessionId), lt(eventsTable.id, beforeId)];
    if (opts.sessionAgentId) conditions.push(eq(eventsTable.sessionAgentId, opts.sessionAgentId));
    return getDb()
      .select()
      .from(eventsTable)
      .where(and(...conditions))
      .orderBy(desc(eventsTable.id))
      .limit(opts.limit ?? 200)
      .all()
      .reverse()
      .map(rowToEvent);
  }
}

function rowToEvent(r: typeof eventsTable.$inferSelect): AgentEvent {
  return {
    id: r.id,
    sessionId: r.sessionId,
    sessionAgentId: r.sessionAgentId,
    type: r.type as any,
    payload: JSON.parse(r.payload),
    ts: r.ts,
  };
}
