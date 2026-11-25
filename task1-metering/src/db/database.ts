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

    -- Per-user limits. Users without a row get DEFAULT_CREDIT_LIMIT.
    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id      TEXT PRIMARY KEY,
      credit_limit INTEGER NOT NULL CHECK (credit_limit >= 0),
      updated_at   TEXT NOT NULL
    );
  `);

  // Idempotency columns, added with ALTER so databases created before this feature are upgraded in place.
  const existing = (db.prepare(`PRAGMA table_info(usage_events)`).all() as { name: string }[]).map((c) => c.name);
  for (const column of ['idempotency_key', 'request_hash', 'response']) {
    if (!existing.includes(column)) db.exec(`ALTER TABLE usage_events ADD COLUMN ${column} TEXT`);
  }
  // One live request per (user, key). Refunded attempts are excluded, so a failed request can be retried with the same key.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_idempotency ON usage_events (user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND status <> 'REFUNDED';
  `);
  return db;
}
