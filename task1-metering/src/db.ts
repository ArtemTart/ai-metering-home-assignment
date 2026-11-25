import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_ledger (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('RESERVED', 'COMMITTED', 'REFUNDED')),
  credits         INTEGER NOT NULL DEFAULT 1 CHECK (credits > 0),
  period_start    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  settled_at      TEXT,
  latency_ms      INTEGER,
  error_code      TEXT,
  response_json   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_idempotency
  ON usage_ledger (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status <> 'REFUNDED';

CREATE INDEX IF NOT EXISTS ix_ledger_user_period ON usage_ledger (user_id, period_start);
CREATE INDEX IF NOT EXISTS ix_ledger_reserved    ON usage_ledger (status, created_at);

CREATE TABLE IF NOT EXISTS user_period_usage (
  user_id      TEXT NOT NULL,
  period_start TEXT NOT NULL,
  reserved     INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  committed    INTEGER NOT NULL DEFAULT 0 CHECK (committed >= 0),
  PRIMARY KEY (user_id, period_start)
);

-- Runtime-adjustable settings (set via the API). A missing row means "use the environment value".
CREATE TABLE IF NOT EXISTS quota_config (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL CHECK (value >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_quota_limit (
  user_id      TEXT PRIMARY KEY,
  credit_limit INTEGER NOT NULL CHECK (credit_limit >= 0),
  updated_at   TEXT NOT NULL
);

-- Evidence must be immutable: no deletes, and only RESERVED rows may change.
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_delete
BEFORE DELETE ON usage_ledger
BEGIN
  SELECT RAISE(ABORT, 'usage_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ledger_settle_once
BEFORE UPDATE ON usage_ledger
WHEN OLD.status <> 'RESERVED'
  OR NEW.status NOT IN ('COMMITTED', 'REFUNDED')
  OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.credits IS NOT OLD.credits OR NEW.period_start IS NOT OLD.period_start
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'usage_ledger rows can only be settled once');
END;
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // FULL: a committed ledger row must survive power loss, not just a process crash.
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
