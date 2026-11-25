import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type {
  Clock,
  QuotaOptions,
  RefundReason,
  ReserveInput,
  ReserveResult,
  StoredResponse,
  Usage,
  UsageEvent,
  UsageStatus,
  UsersOverview,
} from '../types/index.js';
import { periodBounds } from '../utils/period.js';

export function createQuotaService(db: Db, options: QuotaOptions, clock: Clock = () => new Date()) {
  if (!Number.isInteger(options.defaultLimit) || options.defaultLimit < 0) {
    throw new Error(`defaultLimit must be a non-negative integer, got ${options.defaultLimit}`);
  }

  const userLimit = db.prepare(`SELECT credit_limit FROM user_quotas WHERE user_id = ?`);
  const upsertUserLimit = db.prepare(
    `INSERT INTO user_quotas (user_id, credit_limit, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET credit_limit = excluded.credit_limit, updated_at = excluded.updated_at`,
  );
  const deleteUserLimit = db.prepare(`DELETE FROM user_quotas WHERE user_id = ?`);
  // Every user who has made a request or has a custom limit, with their current-period counts.
  const allUsers = db.prepare(
    `WITH users AS (SELECT user_id FROM usage_events UNION SELECT user_id FROM user_quotas)
     SELECT u.user_id                                  AS userId,
            q.credit_limit                             AS customLimit,
            COALESCE(SUM(e.status <> 'REFUNDED'), 0)   AS used,
            COALESCE(SUM(e.status = 'REFUNDED'), 0)    AS refunded
       FROM users u
       LEFT JOIN user_quotas q  ON q.user_id = u.user_id
       LEFT JOIN usage_events e ON e.user_id = u.user_id AND e.period_start = ?
      GROUP BY u.user_id
      ORDER BY u.user_id`,
  );
  const recentEvents = db.prepare(
    `SELECT * FROM usage_events WHERE (@userId IS NULL OR user_id = @userId) ORDER BY created_at DESC LIMIT 500`,
  );
  // In-flight (RESERVED) credits count too, otherwise parallel requests could overspend.
  const countUsed = db.prepare(
    `SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND period_start = ? AND status <> 'REFUNDED'`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO usage_events (id, user_id, status, period_start, created_at, idempotency_key, request_hash)
     VALUES (?, ?, 'RESERVED', ?, ?, ?, ?)`,
  );
  const settleEvent = db.prepare(
    `UPDATE usage_events SET status = ?, settled_at = ?, error = ?, response = ? WHERE id = ? AND status = 'RESERVED'`,
  );
  // A refunded attempt doesn't count: the user never got an answer, so the key may be retried.
  const findByKey = db.prepare(
    `SELECT status, request_hash, response FROM usage_events
      WHERE user_id = ? AND idempotency_key = ? AND status <> 'REFUNDED'`,
  );
  // Fallback for requests without a key: the latest same-prompt request from this user since the cutoff.
  const findRecentSame = db.prepare(
    `SELECT status, request_hash, response FROM usage_events
      WHERE user_id = ? AND idempotency_key IS NULL AND request_hash = ? AND created_at >= ? AND status <> 'REFUNDED'
      ORDER BY created_at DESC LIMIT 1`,
  );
  const dedupeWindowMs = (options.dedupeWindowSeconds ?? 0) * 1000;
  const expireReservations = db.prepare(
    `UPDATE usage_events SET status = 'REFUNDED', settled_at = ?, error = 'RESERVATION_EXPIRED'
      WHERE status = 'RESERVED' AND created_at < ?`,
  );

  function usage(userId: string): Usage {
    const { start, end } = periodBounds(clock(), options.period);
    const { n: used } = countUsed.get(userId, start) as { n: number };
    const row = userLimit.get(userId) as { credit_limit: number } | undefined;
    const limit = row?.credit_limit ?? options.defaultLimit;
    // A limit lowered below current usage blocks new requests; past usage is not clawed back.
    return { userId, limit, used, remaining: Math.max(0, limit - used), periodStart: start, periodEnd: end };
  }

  // IMMEDIATE takes SQLite's write lock before the count, so check-and-insert is atomic
  // even across processes sharing the database file.
  const reserveTx = db.transaction(({ userId, idempotencyKey, requestHash }: ReserveInput): ReserveResult => {
    let previous: { status: UsageStatus; request_hash: string; response: string | null } | undefined;
    if (idempotencyKey) {
      previous = findByKey.get(userId, idempotencyKey) as typeof previous;
    } else if (dedupeWindowMs > 0) {
      const cutoff = new Date(clock().getTime() - dedupeWindowMs).toISOString();
      previous = findRecentSame.get(userId, requestHash, cutoff) as typeof previous;
    }
    if (previous) {
      if (previous.request_hash !== requestHash) return { kind: 'key_reused' };
      if (previous.status === 'RESERVED') return { kind: 'in_progress' };
      return { kind: 'replay', response: JSON.parse(previous.response!) as StoredResponse };
    }

    const current = usage(userId);
    // Allow only on a positive remaining count, so a corrupt limit (e.g. NaN) blocks rather than grants.
    if (!(current.remaining > 0)) return { kind: 'quota_exceeded', usage: current };
    const eventId = randomUUID();
    insertEvent.run(eventId, userId, current.periodStart, clock().toISOString(), idempotencyKey ?? null, requestHash);
    return { kind: 'reserved', eventId };
  });

  return {
    usage,

    /** Atomically checks the idempotency key and the limit, and reserves one credit. */
    reserve: (input: ReserveInput): ReserveResult => reserveTx.immediate(input),

    /** Stores the response so a repeat of the same idempotency key can be replayed. */
    commit(eventId: string, response: StoredResponse): void {
      settleEvent.run('COMMITTED', clock().toISOString(), null, JSON.stringify(response), eventId);
    },

    /** Gives the credit back but keeps the row as evidence of the failed attempt. */
    refund(eventId: string, reason: RefundReason): void {
      settleEvent.run('REFUNDED', clock().toISOString(), reason, null, eventId);
    },

    /**
     * Refunds reservations older than `olderThanMs` — left behind by a crash or a killed process, since a live
     * request always settles within the AI timeout. Returns how many were refunded.
     */
    refundStale(olderThanMs: number): number {
      const now = clock();
      const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
      return expireReservations.run(now.toISOString(), cutoff).changes;
    },

    /** Takes effect on the user's next request. */
    setLimit(userId: string, limit: number): Usage {
      upsertUserLimit.run(userId, limit, clock().toISOString());
      return usage(userId);
    },

    /** Reverts the user to the default limit. */
    resetLimit(userId: string): Usage {
      deleteUserLimit.run(userId);
      return usage(userId);
    },

    listUsers(): UsersOverview {
      const { start, end } = periodBounds(clock(), options.period);
      const rows = allUsers.all(start) as { userId: string; customLimit: number | null; used: number; refunded: number }[];
      return {
        periodStart: start,
        periodEnd: end,
        users: rows.map(({ userId, customLimit, used, refunded }) => {
          const limit = customLimit ?? options.defaultLimit;
          return { userId, limit, customLimit: customLimit !== null, used, refunded, remaining: Math.max(0, limit - used) };
        }),
      };
    },

    /** Raw evidence rows, newest first (max 500). */
    listEvents: (userId?: string): UsageEvent[] => recentEvents.all({ userId: userId ?? null }) as UsageEvent[],
  };
}

export type QuotaService = ReturnType<typeof createQuotaService>;
