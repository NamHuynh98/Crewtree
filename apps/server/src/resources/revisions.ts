// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import { and, desc, eq } from 'drizzle-orm';
import type { ResourceKind, ResourceScope } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { resourceRevisionsTable } from '../db/schema.js';

export type RevisionAction = 'baseline' | 'create' | 'update' | 'delete' | 'move' | 'rollback';

export interface Revision {
  id: string;
  kind: ResourceKind;
  scope: ResourceScope;
  path: string;
  name: string;
  action: RevisionAction;
  content: string;
  createdAt: number;
}

const toRevision = (r: typeof resourceRevisionsTable.$inferSelect): Revision => ({
  ...r,
  kind: r.kind as ResourceKind,
  scope: r.scope as ResourceScope,
  action: r.action as RevisionAction,
});

/** Every write to ~/.claude, ~/.crewtree/agents or <project>/.claude keeps a revision (PLAN.md 6.3). */
let lastTs = 0;
/** Strictly increasing timestamps keep the history order stable within one millisecond. */
function nextTs(): number {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return lastTs;
}

export const Revisions = {
  record(rev: Omit<Revision, 'id' | 'createdAt'>): Revision {
    const row = { ...rev, id: nanoid(), createdAt: nextTs() };
    getDb().insert(resourceRevisionsTable).values(row).run();
    return row;
  },

  list(kind: ResourceKind, name: string): Revision[] {
    return getDb()
      .select()
      .from(resourceRevisionsTable)
      .where(and(eq(resourceRevisionsTable.kind, kind), eq(resourceRevisionsTable.name, name)))
      .orderBy(desc(resourceRevisionsTable.createdAt))
      .all()
      .map(toRevision);
  },

  get(id: string): Revision | undefined {
    const row = getDb().select().from(resourceRevisionsTable).where(eq(resourceRevisionsTable.id, id)).get();
    return row ? toRevision(row) : undefined;
  },

  /**
   * Before Crewtree writes, keep the file as it is on disk when the history does not already end with
   * that content: the first write, or edits made from the CLI/an editor since, can always be restored.
   */
  ensureBaseline(kind: ResourceKind, scope: ResourceScope, path: string, name: string, content: string): void {
    const latest = Revisions.list(kind, name)[0];
    if (!latest || latest.content !== content)
      Revisions.record({ kind, scope, path, name, action: 'baseline', content });
  },
};
