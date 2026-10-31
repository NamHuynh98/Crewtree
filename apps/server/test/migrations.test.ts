// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-legacy-'));

// A DB created before migrations existed: tables from CREATE TABLE IF NOT EXISTS, no __drizzle_migrations
const initialSql = fs.readFileSync(path.resolve(__dirname, '../drizzle/0000_initial.sql'), 'utf8');
const legacy = new Database(path.join(legacyDir, 'crewtree.db'));
legacy.exec(initialSql.replaceAll('--> statement-breakpoint', ''));
legacy.prepare("INSERT INTO projects (id, path, last_opened_at) VALUES ('p1', '/tmp/x', 1)").run();
legacy.close();
process.env.CREWTREE_DIR = legacyDir;

describe('database migrations', () => {
  it('baselines a legacy DB, keeps its data and applies later migrations', async () => {
    const { getDb, closeDb } = await import('../src/db/index.js');
    getDb();
    closeDb();

    const db = new Database(path.join(legacyDir, 'crewtree.db'));
    const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_session_id_idx'")
      .all();
    const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    db.close();

    expect(applied.n).toBe(2);
    expect(indexes).toHaveLength(1);
    expect(projects.n).toBe(1);
  });
});
