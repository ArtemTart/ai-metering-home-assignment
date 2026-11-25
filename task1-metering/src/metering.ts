import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Clock } from './clock.js';
import type { Db } from './db.js';
import { periodBounds, type Period } from './period.js';

export type LedgerStatus = 'RESERVED' | 'COMMITTED' | 'REFUNDED';
export type RefundReason = 'AI_ERROR' | 'AI_TIMEOUT' | 'RESERVATION_EXPIRED';

export class StoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Usage store unavailable', { cause });
  }
}

export interface Usage {
  userId: string;
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

/** The part of a successful response that is replayed verbatim for a repeated idempotency key. */
export interface StoredResponse {
  requestId: string;
  result: string;
}

export type ReserveOutcome =
  | { kind: 'reserved'; requestId: string }
  | { kind: 'quota_exceeded'; usage: Usage }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'in_progress'; requestId: string }
  | { kind: 'idempotency_mismatch'; requestId: string };

export interface ReserveInput {
  userId: string;
  idempotencyKey?: string;
  requestHash: string;
}

export interface LedgerEntry {
  id: string;
  user_id: string;
  idempotency_key: string | null;
  request_hash: string;
  status: LedgerStatus;
  credits: number;
  period_start: string;
  created_at: string;
  settled_at: string | null;
  latency_ms: number | null;
  error_code: string | null;
  response_json: string | null;
}

interface CounterRow {
  reserved: number;
  committed: number;
}

interface SettledRow {
  user_id: string;
  period_start: string;
}

const UNAVAILABLE_CODES = /^SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN|FULL|READONLY|NOTADB|CORRUPT)/;

function prepareStatements(db: Db) {
  return {
    findByKey: db.prepare(
      `SELECT * FROM usage_ledger
        WHERE user_id = ? AND idempotency_key = ? AND status <> 'REFUNDED'`,
    ),
    limitOverride: db.prepare(`SELECT credit_limit FROM user_quota_limit WHERE user_id = ?`),
    upsertLimit: db.prepare(
      `INSERT INTO user_quota_limit (user_id, credit_limit, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET credit_limit = excluded.credit_limit, updated_at = excluded.updated_at`,
    ),
    ensureCounter: db.prepare(
      `INSERT INTO user_period_usage (user_id, period_start) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    ),
    // Check and increment in one statement: there is no window between them.
    tryReserve: db.prepare(
      `UPDATE user_period_usage SET reserved = reserved + 1
        WHERE user_id = ? AND period_start = ? AND reserved + committed + 1 <= ?`,
    ),
    counter: db.prepare(
      `SELECT reserved, committed FROM user_period_usage WHERE user_id = ? AND period_start = ?`,
    ),
    insertLedger: db.prepare(
      `INSERT INTO usage_ledger (id, user_id, idempotency_key, request_hash, status, period_start, created_at)
       VALUES (@id, @userId, @idempotencyKey, @requestHash, 'RESERVED', @periodStart, @createdAt)`,
    ),
    // `AND status = 'RESERVED'` makes settlement idempotent and race-safe against the reaper.
    markCommitted: db.prepare(
      `UPDATE usage_ledger
          SET status = 'COMMITTED', settled_at = @settledAt, latency_ms = @latencyMs, response_json = @responseJson
        WHERE id = @id AND status = 'RESERVED'
        RETURNING user_id, period_start`,
    ),
    markRefunded: db.prepare(
      `UPDATE usage_ledger
          SET status = 'REFUNDED', settled_at = @settledAt, latency_ms = @latencyMs, error_code = @errorCode
        WHERE id = @id AND status = 'RESERVED'
        RETURNING user_id, period_start`,
    ),
    counterCommit: db.prepare(
      `UPDATE user_period_usage SET reserved = reserved - 1, committed = committed + 1
        WHERE user_id = ? AND period_start = ?`,
    ),
    counterRelease: db.prepare(
      `UPDATE user_period_usage SET reserved = reserved - 1 WHERE user_id = ? AND period_start = ?`,
    ),
    staleReservations: db.prepare(
      `SELECT id FROM usage_ledger WHERE status = 'RESERVED' AND created_at < ?`,
    ),
    ledgerForUser: db.prepare(
      `SELECT * FROM usage_ledger WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ?`,
    ),
  };
}

export class MeteringService {
  private readonly stmt: ReturnType<typeof prepareStatements>;
  private readonly reserveTx: Database.Transaction<(input: ReserveInput) => ReserveOutcome>;
  private readonly expireTx: Database.Transaction<(cutoff: string) => number>;

  constructor(
    private readonly db: Db,
    private readonly options: { defaultLimit: number; period: Period },
    private readonly clock: Clock,
  ) {
    this.stmt = prepareStatements(db);
    this.reserveTx = db.transaction((input: ReserveInput): ReserveOutcome => this.reserveInTx(input));
    this.expireTx = db.transaction((cutoff: string): number => {
      const rows = this.stmt.staleReservations.all(cutoff) as { id: string }[];
      let refunded = 0;
      for (const { id } of rows) {
        if (this.refundInTx(id, 'RESERVATION_EXPIRED', null)) refunded++;
      }
      return refunded;
    });
  }

  /** Atomically checks idempotency and quota, and reserves one credit. */
  reserve(input: ReserveInput): ReserveOutcome {
    // IMMEDIATE takes the write lock up front, so concurrent connections serialize here.
    return this.store(() => this.reserveTx.immediate(input));
  }

  /** Returns false if the reservation was already settled (e.g. refunded by the reaper). */
  commit(requestId: string, details: { latencyMs: number; response: StoredResponse }): boolean {
    return this.store(() =>
      this.db.transaction(() => {
        const row = this.stmt.markCommitted.get({
          id: requestId,
          settledAt: this.clock().toISOString(),
          latencyMs: Math.round(details.latencyMs),
          responseJson: JSON.stringify(details.response),
        }) as SettledRow | undefined;
        if (!row) return false;
        this.stmt.counterCommit.run(row.user_id, row.period_start);
        return true;
      })(),
    );
  }

  /** Returns false if the reservation was already settled. */
  refund(requestId: string, reason: RefundReason, latencyMs: number | null): boolean {
    return this.store(() => this.db.transaction(() => this.refundInTx(requestId, reason, latencyMs))());
  }

  /** Refunds reservations orphaned by a crash. Returns how many were refunded. */
  expireReservationsOlderThan(cutoff: Date): number {
    return this.store(() => this.expireTx.immediate(cutoff.toISOString()));
  }

  getUsage(userId: string): Usage {
    return this.store(() => this.usageAt(userId, this.clock()));
  }

  setLimit(userId: string, limit: number): Usage {
    return this.store(() => {
      this.stmt.upsertLimit.run(userId, limit, this.clock().toISOString());
      return this.usageAt(userId, this.clock());
    });
  }

  listLedger(userId: string, max = 100): LedgerEntry[] {
    return this.store(() => this.stmt.ledgerForUser.all(userId, max) as LedgerEntry[]);
  }

  private reserveInTx(input: ReserveInput): ReserveOutcome {
    const now = this.clock();
    const periodStart = periodBounds(now, this.options.period).start.toISOString();

    if (input.idempotencyKey !== undefined) {
      const existing = this.stmt.findByKey.get(input.userId, input.idempotencyKey) as LedgerEntry | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          return { kind: 'idempotency_mismatch', requestId: existing.id };
        }
        if (existing.status === 'RESERVED') return { kind: 'in_progress', requestId: existing.id };
        return { kind: 'replay', response: JSON.parse(existing.response_json!) as StoredResponse };
      }
    }

    const limit = this.limitFor(input.userId);
    this.stmt.ensureCounter.run(input.userId, periodStart);
    if (this.stmt.tryReserve.run(input.userId, periodStart, limit).changes === 0) {
      return { kind: 'quota_exceeded', usage: this.usageAt(input.userId, now) };
    }

    const requestId = randomUUID();
    this.stmt.insertLedger.run({
      id: requestId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey ?? null,
      requestHash: input.requestHash,
      periodStart,
      createdAt: now.toISOString(),
    });
    return { kind: 'reserved', requestId };
  }

  private refundInTx(requestId: string, reason: RefundReason, latencyMs: number | null): boolean {
    const row = this.stmt.markRefunded.get({
      id: requestId,
      settledAt: this.clock().toISOString(),
      latencyMs: latencyMs === null ? null : Math.round(latencyMs),
      errorCode: reason,
    }) as SettledRow | undefined;
    if (!row) return false;
    this.stmt.counterRelease.run(row.user_id, row.period_start);
    return true;
  }

  private usageAt(userId: string, now: Date): Usage {
    const { start, end } = periodBounds(now, this.options.period);
    const counter = this.stmt.counter.get(userId, start.toISOString()) as CounterRow | undefined;
    const limit = this.limitFor(userId);
    const used = counter?.committed ?? 0;
    const reserved = counter?.reserved ?? 0;
    return {
      userId,
      limit,
      used,
      reserved,
      remaining: Math.max(0, limit - used - reserved),
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    };
  }

  private limitFor(userId: string): number {
    const row = this.stmt.limitOverride.get(userId) as { credit_limit: number } | undefined;
    return row?.credit_limit ?? this.options.defaultLimit;
  }

  /** Infrastructure failures become StoreUnavailableError (-> 503); programming errors propagate as-is. */
  private store<T>(fn: () => T): T {
    if (!this.db.open) throw new StoreUnavailableError(new Error('database connection is closed'));
    try {
      return fn();
    } catch (err) {
      if (err instanceof Database.SqliteError && UNAVAILABLE_CODES.test(err.code)) {
        throw new StoreUnavailableError(err);
      }
      throw err;
    }
  }
}
