import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type {
  Clock,
  QuotaOptions,
  RefundReason,
  ReserveResult,
  Usage,
  UsageEvent,
  UsersOverview,
} from '../types/index.js';
import { periodBounds } from '../utils/period.js';

export function createQuotaService(db: Db, options: QuotaOptions, clock: Clock = () => new Date()) {
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
    `INSERT INTO usage_events (id, user_id, status, period_start, created_at) VALUES (?, ?, 'RESERVED', ?, ?)`,
  );
  const settleEvent = db.prepare(
    `UPDATE usage_events SET status = ?, settled_at = ?, error = ? WHERE id = ? AND status = 'RESERVED'`,
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
  const reserveTx = db.transaction((userId: string): ReserveResult => {
    const current = usage(userId);
    if (current.remaining === 0) return { ok: false, usage: current };
    const eventId = randomUUID();
    insertEvent.run(eventId, userId, current.periodStart, clock().toISOString());
    return { ok: true, eventId };
  });

  return {
    usage,

    /** Atomically checks the limit and reserves one credit. */
    reserve: (userId: string): ReserveResult => reserveTx.immediate(userId),

    commit(eventId: string): void {
      settleEvent.run('COMMITTED', clock().toISOString(), null, eventId);
    },

    /** Gives the credit back but keeps the row as evidence of the failed attempt. */
    refund(eventId: string, reason: RefundReason): void {
      settleEvent.run('REFUNDED', clock().toISOString(), reason, eventId);
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
