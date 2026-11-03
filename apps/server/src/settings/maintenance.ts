// SPDX-License-Identifier: Apache-2.0
import { and, inArray, lt } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { eventsTable, sessionsTable } from '../db/schema.js';
import { getAppSettings } from './appSettings.js';

const CLOSED = ['completed', 'stopped', 'error'];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Settings → Limits "Keep events of closed sessions [N] days" (UI-WIREFRAMES 13): drops the event log of
 * sessions that are closed and untouched for longer. Sessions, tasks and messages stay.
 */
export function cleanupEvents(days = getAppSettings().limits.defaults.eventsRetentionDays, now = Date.now()): number {
  const db = getDb();
  const old = db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(and(inArray(sessionsTable.status, CLOSED), lt(sessionsTable.updatedAt, now - days * DAY_MS)))
    .all()
    .map((r) => r.id);
  if (!old.length) return 0;
  return db.delete(eventsTable).where(inArray(eventsTable.sessionId, old)).run().changes;
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Once at start, then daily. */
export function scheduleCleanup(): void {
  const run = () => {
    try {
      const n = cleanupEvents();
      if (n) console.log(`[maintenance] removed ${n} events of closed sessions`);
    } catch (err) {
      console.warn('[maintenance] event cleanup failed:', err);
    }
  };
  run();
  timer = setInterval(run, DAY_MS);
  timer.unref?.();
}

export function stopCleanup(): void {
  if (timer) clearInterval(timer);
}
