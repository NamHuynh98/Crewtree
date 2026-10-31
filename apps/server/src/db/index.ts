// SPDX-License-Identifier: Apache-2.0
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

    dbInstance = drizzle(sqliteDb, { schema });

    const migrationsFolder = getMigrationsFolder();
    baselineLegacyDb(sqliteDb, migrationsFolder);
    migrate(dbInstance, { migrationsFolder });

    // Seed default app settings if not present
    seedDefaults(dbInstance);
  }
  return dbInstance;
}

/** Folder with drizzle-kit migrations (apps/server/drizzle), same relative path from src/ and dist/. */
function getMigrationsFolder(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
}

/**
 * DBs created before migrations existed (CREATE TABLE IF NOT EXISTS) already match 0000_initial:
 * record it as applied so the migrator only runs later migrations.
 */
function baselineLegacyDb(db: Database.Database, migrationsFolder: string) {
  const hasTable = (name: string) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  if (!hasTable('sessions') || hasTable('__drizzle_migrations')) return;

  const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
  const initial = journal.entries[0];
  const sql = fs.readFileSync(path.join(migrationsFolder, `${initial.tag}.sql`), 'utf8');
  db.exec(
    'CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)'
  );
  db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(
    crypto.createHash('sha256').update(sql).digest('hex'),
    initial.when
  );
}

function seedDefaults(db: ReturnType<typeof drizzle<typeof schema>>) {
  const existing = db.select().from(schema.appSettingsTable).where(eq(schema.appSettingsTable.key, 'global')).get();
  if (!existing) {
    const defaultSettings = AppSettingsSchema.parse({});
    db.insert(schema.appSettingsTable)
      .values({
        key: 'global',
        value: JSON.stringify(defaultSettings),
        updatedAt: Date.now(),
      })
      .run();
  }
}

export function closeDb() {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    dbInstance = null;
  }
}
