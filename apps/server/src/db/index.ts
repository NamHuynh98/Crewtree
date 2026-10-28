// SPDX-License-Identifier: Apache-2.0
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { getDbPath, ensureDirectories } from '../paths.js';
import { eq } from 'drizzle-orm';
import { AppSettingsSchema } from '@crewtree/shared';

let sqliteDb: Database.Database | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!dbInstance) {
    ensureDirectories();
    const dbPath = getDbPath();
    sqliteDb = new Database(dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');

    // Auto-create tables if they don't exist
    initTables(sqliteDb);

    dbInstance = drizzle(sqliteDb, { schema });

    // Seed default app settings if not present
    seedDefaults(dbInstance);
  }
  return dbInstance;
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_revisions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      last_opened_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      supervisor_agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      settings TEXT NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_turns INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_agents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      scope TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      parent_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      alias TEXT,
      spawned_by TEXT NOT NULL DEFAULT 'user',
      model_override TEXT,
      can_delegate_override INTEGER,
      fresh_context_override INTEGER,
      sdk_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_active_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT NOT NULL,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      is_root INTEGER NOT NULL DEFAULT 0,
      question TEXT,
      answer TEXT,
      result_summary TEXT,
      result_details TEXT,
      completed_by TEXT,
      started_at INTEGER,
      ended_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      task_id TEXT,
      delivery TEXT NOT NULL DEFAULT 'delivered',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_agent_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_agent_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rule TEXT,
      pattern TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS file_touches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_agent_id TEXT NOT NULL,
      task_id TEXT,
      path TEXT NOT NULL,
      op TEXT NOT NULL,
      snapshot_path TEXT,
      ts INTEGER NOT NULL
    );
  `);
}

function seedDefaults(db: ReturnType<typeof drizzle<typeof schema>>) {
  const existing = db.select().from(schema.appSettingsTable).where(eq(schema.appSettingsTable.key, 'global')).get();
  if (!existing) {
    const defaultSettings = AppSettingsSchema.parse({});
    db.insert(schema.appSettingsTable).values({
      key: 'global',
      value: JSON.stringify(defaultSettings),
      updatedAt: Date.now(),
    }).run();
  }
}

export function closeDb() {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    dbInstance = null;
  }
}
