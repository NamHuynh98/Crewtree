// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'events';
import { AgentEvent } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { eventsTable } from '../db/schema.js';
import { gt, and, eq, asc } from 'drizzle-orm';

export interface WsSocket {
  readyState: number;
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

export class EventBus extends EventEmitter {
  private static instance: EventBus;
  private wsClients = new Set<{ ws: WsSocket; sessionId?: string }>();

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
    ws.on('close', () => {
      this.wsClients.delete(client);
    });
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

    // Persist to SQLite unless it is a high-frequency ephemeral text delta
    // Text deltas are streamed via WS but only aggregated text.done is persisted
    if (event.type !== 'agent.text.delta') {
      try {
        const result = db.insert(eventsTable).values({
          sessionId: event.sessionId,
          sessionAgentId: event.sessionAgentId ?? null,
          type: event.type,
          payload: JSON.stringify(event.payload),
          ts: event.ts || Date.now(),
        }).run();
        savedEventId = Number(result.lastInsertRowid);
      } catch (err) {
        console.error('Failed to persist event to SQLite:', err);
      }
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

  private broadcastWs(event: AgentEvent) {
    const payloadStr = JSON.stringify(event);
    for (const client of this.wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        // Global events or matching session events
        if (!client.sessionId || client.sessionId === event.sessionId || !event.sessionId) {
          try {
            client.ws.send(payloadStr);
          } catch (e) {
            console.error('Error broadcasting WS event:', e);
          }
        }
      }
    }
  }

  public getEventsAfter(sessionId: string, lastEventId: number): AgentEvent[] {
    const db = getDb();
    const rows = db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), gt(eventsTable.id, lastEventId)))
      .orderBy(asc(eventsTable.id))
      .all();

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      sessionAgentId: r.sessionAgentId,
      type: r.type as any,
      payload: JSON.parse(r.payload),
      ts: r.ts,
    }));
  }
}
