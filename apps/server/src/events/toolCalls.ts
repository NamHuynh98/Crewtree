// SPDX-License-Identifier: Apache-2.0
/**
 * Tool calls that will never get a result: the turn ended (interrupt, cancel, driver error) or the server
 * died while they ran. Without an `agent.tool.end` the chat showed them running forever ("waiting for
 * results…" spinning after a restart).
 *
 * Closing one marks its stored `agent.tool.start` as `interrupted` — a chat page holding the start but not
 * the end (pages are built independently) still shows it closed — and emits an error `agent.tool.end` so
 * open UIs update at once.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { EventBus } from './EventBus.js';

export const TURN_ENDED = 'Interrupted: the turn ended before this tool returned.';
export const SERVER_STOPPED = 'Interrupted: the Crewtree server stopped before this tool returned.';

export interface OpenToolCall {
  sessionId: string;
  sessionAgentId: string;
  toolUseId: string;
  parentToolUseId?: string | null;
}

export function closeToolCalls(calls: OpenToolCall[], reason: string): void {
  const db = getDb();
  for (const call of calls) {
    db.run(sql`UPDATE events SET payload = json_set(payload, '$.interrupted', json('true'))
      WHERE session_agent_id = ${call.sessionAgentId} AND type = 'agent.tool.start'
        AND json_extract(payload, '$.toolUseId') = ${call.toolUseId}`);
    EventBus.getInstance().emitEvent({
      sessionId: call.sessionId,
      sessionAgentId: call.sessionAgentId,
      type: 'agent.tool.end',
      payload: {
        toolUseId: call.toolUseId,
        output: reason,
        isError: true,
        interrupted: true,
        parentToolUseId: call.parentToolUseId ?? undefined,
      },
      ts: Date.now(),
    });
  }
}

/**
 * Every stored tool call without a result. Only meaningful at startup, when nothing runs: each one belonged
 * to a process that is gone. One pass over the tool events.
 */
export function findOpenToolCalls(): OpenToolCall[] {
  const rows = getDb().all<{
    sessionId: string;
    sessionAgentId: string | null;
    type: string;
    toolUseId: string | null;
    parentToolUseId: string | null;
    interrupted: number | null;
  }>(sql`SELECT session_id AS sessionId, session_agent_id AS sessionAgentId, type,
      json_extract(payload, '$.toolUseId') AS toolUseId,
      json_extract(payload, '$.parentToolUseId') AS parentToolUseId,
      json_extract(payload, '$.interrupted') AS interrupted
    FROM events WHERE type IN ('agent.tool.start', 'agent.tool.end') ORDER BY id`);
  const open = new Map<string, OpenToolCall>();
  for (const r of rows) {
    if (!r.sessionAgentId || !r.toolUseId) continue;
    const key = `${r.sessionAgentId}\u0000${r.toolUseId}`;
    if (r.type === 'agent.tool.end') open.delete(key);
    else if (!r.interrupted) {
      open.set(key, {
        sessionId: r.sessionId,
        sessionAgentId: r.sessionAgentId,
        toolUseId: r.toolUseId,
        parentToolUseId: r.parentToolUseId,
      });
    }
  }
  return [...open.values()];
}
