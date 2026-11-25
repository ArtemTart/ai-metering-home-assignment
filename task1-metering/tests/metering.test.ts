import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { MeteringService, StoreUnavailableError, type ReserveOutcome } from '../src/metering.js';
import { fakeClock } from './helpers.js';

const response = (requestId: string) => ({ requestId, result: 'ok' });

function reservedId(outcome: ReserveOutcome): string {
  if (outcome.kind !== 'reserved') throw new Error(`expected a reservation, got ${outcome.kind}`);
  return outcome.requestId;
}

/** The counter table must always equal what the ledger says. */
function expectCountersMatchLedger(db: Db) {
  const mismatches = db
    .prepare(
      `SELECT c.user_id, c.period_start, c.reserved, c.committed,
              COALESCE(SUM(l.status = 'RESERVED'), 0)  AS ledger_reserved,
              COALESCE(SUM(l.status = 'COMMITTED'), 0) AS ledger_committed
         FROM user_period_usage c
         LEFT JOIN usage_ledger l ON l.user_id = c.user_id AND l.period_start = c.period_start
        GROUP BY c.user_id, c.period_start
       HAVING c.reserved <> ledger_reserved OR c.committed <> ledger_committed`,
    )
    .all();
  expect(mismatches).toEqual([]);
}

describe('MeteringService', () => {
  let db: Db;
  let time: ReturnType<typeof fakeClock>;
  let metering: MeteringService;

  beforeEach(() => {
    db = openDb(':memory:');
    time = fakeClock('2026-03-15T12:00:00.000Z');
    metering = new MeteringService(db, { defaultLimit: 3, period: 'month' }, time.clock);
  });

  const reserve = (key?: string, hash = 'h1', userId = 'alice') =>
    metering.reserve({ userId, idempotencyKey: key, requestHash: hash });

  describe('quota', () => {
    it('reserves up to the limit, then rejects', () => {
      expect(reserve().kind).toBe('reserved');
      expect(reserve().kind).toBe('reserved');
      expect(reserve().kind).toBe('reserved');
      const rejected = reserve();
      expect(rejected.kind).toBe('quota_exceeded');
      expect(rejected.kind === 'quota_exceeded' && rejected.usage).toMatchObject({ limit: 3, reserved: 3, remaining: 0 });
    });

    it('counts in-flight reservations against the quota, separately from used credits', () => {
      const a = reservedId(reserve());
      reserve();
      metering.commit(a, { latencyMs: 10, response: response(a) });
      expect(metering.getUsage('alice')).toMatchObject({ used: 1, reserved: 1, remaining: 1 });
    });

    it('gives the credit back on refund, but keeps the ledger row as evidence', () => {
      for (let i = 0; i < 3; i++) reserve();
      const [first] = metering.listLedger('alice');
      expect(metering.refund(first!.id, 'AI_ERROR', 12)).toBe(true);

      expect(metering.getUsage('alice')).toMatchObject({ used: 0, reserved: 2, remaining: 1 });
      expect(reserve().kind).toBe('reserved');
      const row = metering.listLedger('alice').find((e) => e.id === first!.id);
      expect(row).toMatchObject({ status: 'REFUNDED', error_code: 'AI_ERROR', latency_ms: 12 });
      expect(metering.listLedger('alice')).toHaveLength(4);
    });

    it('keeps quotas independent per user', () => {
      for (let i = 0; i < 3; i++) reserve(undefined, 'h', 'alice');
      expect(reserve(undefined, 'h', 'alice').kind).toBe('quota_exceeded');
      expect(reserve(undefined, 'h', 'bob').kind).toBe('reserved');
    });

    it('blocks everything when the limit is 0', () => {
      metering.setLimit('alice', 0);
      expect(reserve().kind).toBe('quota_exceeded');
      expect(metering.getUsage('alice').remaining).toBe(0);
    });

    it('applies a lowered limit immediately without clawing back past usage', () => {
      const a = reservedId(reserve());
      const b = reservedId(reserve());
      metering.commit(a, { latencyMs: 1, response: response(a) });
      metering.commit(b, { latencyMs: 1, response: response(b) });

      expect(metering.setLimit('alice', 1)).toMatchObject({ limit: 1, used: 2, remaining: 0 });
      expect(reserve().kind).toBe('quota_exceeded');
    });

    it('applies a raised limit immediately', () => {
      for (let i = 0; i < 3; i++) reserve();
      metering.setLimit('alice', 5);
      expect(reserve().kind).toBe('reserved');
    });
  });

  describe('default limit', () => {
    it('falls back to the environment value until one is set via the API', () => {
      expect(metering.getDefaultLimit()).toEqual({ limit: 3, source: 'env', updatedAt: null });
    });

    it('applies an API-set default to users without an override, from their next request', () => {
      for (let i = 0; i < 3; i++) reserve();
      expect(reserve().kind).toBe('quota_exceeded');

      expect(metering.setDefaultLimit(5)).toMatchObject({ limit: 5, source: 'api' });
      expect(reserve().kind).toBe('reserved');
      expect(metering.getUsage('bob').limit).toBe(5);
    });

    it('never overrides a per-user limit', () => {
      metering.setLimit('alice', 1);
      metering.setDefaultLimit(50);
      expect(metering.getUsage('alice').limit).toBe(1);
    });

    it('reverts to the environment value on reset', () => {
      metering.setDefaultLimit(50);
      expect(metering.resetDefaultLimit()).toEqual({ limit: 3, source: 'env', updatedAt: null });
      expect(metering.getUsage('alice').limit).toBe(3);
    });

    it('is persisted, so a restarted instance with a different env value still uses it', () => {
      metering.setDefaultLimit(7);
      const restarted = new MeteringService(db, { defaultLimit: 999, period: 'month' }, time.clock);
      expect(restarted.getUsage('alice').limit).toBe(7);
    });

    it('rejects a negative default at the database level', () => {
      expect(() => metering.setDefaultLimit(-1)).toThrow(/CHECK/);
    });
  });

  describe('periods', () => {
    it('starts a fresh quota in the next period', () => {
      for (let i = 0; i < 3; i++) reserve();
      expect(reserve().kind).toBe('quota_exceeded');

      time.set('2026-04-01T00:00:00.000Z');
      expect(reserve().kind).toBe('reserved');
      expect(metering.getUsage('alice')).toMatchObject({ periodStart: '2026-04-01T00:00:00.000Z', reserved: 1 });
    });

    it('settles a request that straddles the boundary in the period it was reserved in', () => {
      time.set('2026-03-31T23:59:59.999Z');
      const id = reservedId(reserve());

      time.set('2026-04-01T00:00:00.500Z');
      metering.commit(id, { latencyMs: 501, response: response(id) });

      expect(metering.getUsage('alice')).toMatchObject({ used: 0, reserved: 0, remaining: 3 });
      const march = db
        .prepare(`SELECT reserved, committed FROM user_period_usage WHERE period_start = '2026-03-01T00:00:00.000Z'`)
        .get();
      expect(march).toEqual({ reserved: 0, committed: 1 });
      expectCountersMatchLedger(db);
    });
  });

  describe('settlement', () => {
    it('is idempotent: a second commit or a late refund is a no-op', () => {
      const id = reservedId(reserve());
      expect(metering.commit(id, { latencyMs: 5, response: response(id) })).toBe(true);
      expect(metering.commit(id, { latencyMs: 5, response: response(id) })).toBe(false);
      expect(metering.refund(id, 'AI_ERROR', 5)).toBe(false);
      expect(metering.getUsage('alice')).toMatchObject({ used: 1, reserved: 0 });
      expectCountersMatchLedger(db);
    });

    it('lets whichever of reaper and request settles first win', () => {
      const id = reservedId(reserve());
      time.advance(60_000);
      expect(metering.expireReservationsOlderThan(new Date(time.clock().getTime() - 30_000))).toBe(1);

      expect(metering.commit(id, { latencyMs: 60_000, response: response(id) })).toBe(false);
      expect(metering.listLedger('alice')[0]).toMatchObject({ status: 'REFUNDED', error_code: 'RESERVATION_EXPIRED' });
      expect(metering.getUsage('alice')).toMatchObject({ used: 0, reserved: 0, remaining: 3 });
    });

    it('reaper only touches reservations older than the cutoff', () => {
      reserve();
      time.advance(10_000);
      const fresh = reservedId(reserve());

      expect(metering.expireReservationsOlderThan(new Date(time.clock().getTime() - 5_000))).toBe(1);
      expect(metering.listLedger('alice').find((e) => e.id === fresh)?.status).toBe('RESERVED');
      expectCountersMatchLedger(db);
    });
  });

  describe('idempotency', () => {
    it('replays a committed request instead of charging again', () => {
      const id = reservedId(reserve('k1'));
      metering.commit(id, { latencyMs: 5, response: response(id) });

      expect(reserve('k1')).toEqual({ kind: 'replay', response: response(id) });
      expect(metering.getUsage('alice').used).toBe(1);
    });

    it('reports a request with the same key that is still in flight', () => {
      const id = reservedId(reserve('k1'));
      expect(reserve('k1')).toEqual({ kind: 'in_progress', requestId: id });
      expect(metering.getUsage('alice').reserved).toBe(1);
    });

    it('rejects a reused key with a different body', () => {
      reserve('k1', 'hash-a');
      expect(reserve('k1', 'hash-b').kind).toBe('idempotency_mismatch');
    });

    it('allows a new attempt with the same key after a refunded failure', () => {
      const failed = reservedId(reserve('k1'));
      metering.refund(failed, 'AI_TIMEOUT', 50);

      const retry = reservedId(reserve('k1'));
      expect(retry).not.toBe(failed);
      expect(metering.listLedger('alice').map((e) => e.status).sort()).toEqual(['REFUNDED', 'RESERVED']);
    });

    it('scopes keys per user', () => {
      reserve('shared-key', 'h', 'alice');
      expect(reserve('shared-key', 'h', 'bob').kind).toBe('reserved');
    });

    it('still checks the quota when the key is new', () => {
      for (let i = 0; i < 3; i++) reserve(`k${i}`);
      expect(reserve('k-new').kind).toBe('quota_exceeded');
    });
  });

  describe('evidence', () => {
    it('refuses to delete ledger rows', () => {
      reserve();
      expect(() => db.prepare('DELETE FROM usage_ledger').run()).toThrow(/append-only/);
    });

    it('refuses to change a settled row', () => {
      const id = reservedId(reserve());
      metering.commit(id, { latencyMs: 5, response: response(id) });
      expect(() => db.prepare(`UPDATE usage_ledger SET status = 'REFUNDED' WHERE id = ?`).run(id)).toThrow(
        /settled once/,
      );
    });

    it('refuses to rewrite identifying fields even while reserved', () => {
      const id = reservedId(reserve());
      expect(() => db.prepare(`UPDATE usage_ledger SET user_id = 'mallory' WHERE id = ?`).run(id)).toThrow();
    });

    it('records the request hash and the reservation period on every row', () => {
      reserve(undefined, 'abc123');
      expect(metering.listLedger('alice')[0]).toMatchObject({
        request_hash: 'abc123',
        period_start: '2026-03-01T00:00:00.000Z',
        created_at: '2026-03-15T12:00:00.000Z',
        credits: 1,
      });
    });
  });

  it('keeps counters equal to the ledger through a random sequence of operations', () => {
    let seed = 42;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    metering.setLimit('alice', 20);
    const open: string[] = [];

    for (let step = 0; step < 500; step++) {
      const roll = random();
      if (roll < 0.5) {
        const outcome = reserve(random() < 0.3 ? `k${Math.floor(random() * 10)}` : undefined);
        if (outcome.kind === 'reserved') open.push(outcome.requestId);
      } else if (open.length > 0) {
        const id = open.splice(Math.floor(random() * open.length), 1)[0]!;
        if (roll < 0.8) metering.commit(id, { latencyMs: 1, response: response(id) });
        else metering.refund(id, 'AI_ERROR', 1);
      }
      if (step % 100 === 99) time.advance(10 * 24 * 60 * 60 * 1000);
    }

    expectCountersMatchLedger(db);
  });

  it('reports a closed store as unavailable rather than crashing', () => {
    db.close();
    expect(() => reserve()).toThrow(StoreUnavailableError);
    expect(() => metering.getUsage('alice')).toThrow(StoreUnavailableError);
  });
});
