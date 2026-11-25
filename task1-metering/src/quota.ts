import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export type Period = 'hour' | 'day' | 'month';
export type Clock = () => Date;

export interface Usage {
  userId: string;
  limit: number;
  used: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

export type ReserveResult = { ok: true; eventId: string } | { ok: false; usage: Usage };

/** Fixed, calendar-aligned UTC windows: they match billing cycles and ignore DST. */
export function periodBounds(now: Date, period: Period) {
  const [y, m, d, h] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()];
  const [start, end] = {
    hour: [Date.UTC(y, m, d, h), Date.UTC(y, m, d, h + 1)],
    day: [Date.UTC(y, m, d), Date.UTC(y, m, d + 1)],
    month: [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)],
  }[period];
  return { start: new Date(start!).toISOString(), end: new Date(end!).toISOString() };
}

export function createQuota(db: Db, options: { limit: number; period: Period }, clock: Clock = () => new Date()) {
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
    return { userId, limit: options.limit, used, remaining: Math.max(0, options.limit - used), periodStart: start, periodEnd: end };
  }

  // IMMEDIATE takes SQLite's write lock before the count, so check-and-insert is atomic
  // even across processes sharing the database file.
  const reserveTx = db.transaction((userId: string): ReserveResult => {
    const current = usage(userId);
    if (current.used >= options.limit) return { ok: false, usage: current };
    const eventId = randomUUID();
    insertEvent.run(eventId, userId, current.periodStart, clock().toISOString());
    return { ok: true, eventId };
  });

  return {
    usage,
    /** Atomically checks the limit and reserves one credit. */
    reserve: (userId: string) => reserveTx.immediate(userId),
    commit: (eventId: string) => settleEvent.run('COMMITTED', clock().toISOString(), null, eventId),
    /** Gives the credit back but keeps the row as evidence of the failed attempt. */
    refund: (eventId: string, error: string) => settleEvent.run('REFUNDED', clock().toISOString(), error, eventId),
  };
}

export type Quota = ReturnType<typeof createQuota>;
