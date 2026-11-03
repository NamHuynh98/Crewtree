// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { projectsTable } from '../db/schema.js';
import { EventBus } from '../events/EventBus.js';
import { getHomeDir, normalizePath } from '../paths.js';

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number;
}

/**
 * The project whose `<cwd>/.claude` is loaded as project scope (PLAN.md 6.1, UI-WIREFRAMES 0).
 * Starts as `crewtree [path]` (CREWTREE_PROJECT) or the directory the command was run from;
 * `pnpm --filter … dev` runs inside apps/server, so INIT_CWD (where pnpm was invoked) wins over cwd.
 */
export class ProjectService {
  private static instance: ProjectService;
  private current: string;
  private listeners = new Set<(projectPath: string) => void>();

  private constructor() {
    this.current = path.resolve(process.env.CREWTREE_PROJECT || process.env.INIT_CWD || process.cwd());
  }

  public static getInstance(): ProjectService {
    if (!ProjectService.instance) ProjectService.instance = new ProjectService();
    return ProjectService.instance;
  }

  public currentPath(): string {
    return this.current;
  }

  public currentInfo() {
    return {
      path: normalizePath(this.current),
      name: path.basename(this.current),
      homeDir: normalizePath(getHomeDir()),
    };
  }

  public list(): ProjectInfo[] {
    return getDb()
      .select()
      .from(projectsTable)
      .orderBy(desc(projectsTable.lastOpenedAt))
      .all()
      .map((p) => ({ ...p, name: path.basename(p.path) }));
  }

  /** Switches the project scope; resources are rescanned and the watcher follows. */
  public open(projectPath: string): ProjectInfo {
    const resolved = path.resolve(projectPath.replace(/^~(?=$|[\\/])/, getHomeDir()));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Folder not found: ${projectPath}`);
    }
    const db = getDb();
    const now = Date.now();
    const existing = db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.path, normalizePath(resolved)))
      .get();
    if (existing) db.update(projectsTable).set({ lastOpenedAt: now }).where(eq(projectsTable.id, existing.id)).run();
    else
      db.insert(projectsTable)
        .values({ id: nanoid(), path: normalizePath(resolved), lastOpenedAt: now })
        .run();

    const changed = resolved !== this.current;
    this.current = resolved;
    if (changed) {
      for (const listener of this.listeners) listener(resolved);
      EventBus.getInstance().emitEvent({
        sessionId: '',
        type: 'resource.changed',
        payload: { kind: '*', reason: 'project', project: this.currentInfo() },
        ts: now,
      });
    }
    const row = db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.path, normalizePath(resolved)))
      .get()!;
    return { ...row, name: path.basename(row.path) };
  }

  public onChange(listener: (projectPath: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
