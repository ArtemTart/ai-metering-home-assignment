import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // One row per AI request: the evidence for billing, audits and disputes. Rows are never deleted;
  // a failed call is kept as REFUNDED so the attempt remains on record.
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('RESERVED', 'COMMITTED', 'REFUNDED')),
      period_start TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      settled_at   TEXT,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_usage_user_period ON usage_events (user_id, period_start, status);
  `);
  return db;
}
