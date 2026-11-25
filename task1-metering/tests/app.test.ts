import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db/database.js';
import { AiTimeoutError, withTimeout } from '../src/services/ai.service.js';
import { createQuotaService } from '../src/services/quota.service.js';
import { periodBounds } from '../src/utils/period.js';

/** Builds the app with an in-memory DB, a controllable clock and an AI that answers instantly unless told otherwise. */
function setup({ limit = 3, aiTimeoutMs = 50 } = {}) {
  const db = openDb(':memory:');
  let now = new Date('2026-03-15T12:00:00.000Z');
  const ai = { mode: 'ok' as 'ok' | 'fail' | 'hang', calls: 0 };
  const app = buildApp({
    quota: createQuotaService(db, { defaultLimit: limit, period: 'month' }, () => now),
    ai: async (prompt) => {
      ai.calls++;
      if (ai.mode === 'fail') throw new Error('boom');
      if (ai.mode === 'hang') return new Promise<string>(() => {});
      return `answer: ${prompt}`;
    },
    aiTimeoutMs,
  });
  const send = (user = 'alice', body: object = { prompt: 'hi' }) =>
    app.inject({ method: 'POST', url: '/v1/ai/requests', headers: { 'x-user-id': user }, payload: body });
  const usage = async (user = 'alice') => (await app.inject({ url: `/v1/users/${user}/usage` })).json();
  const events = () => db.prepare('SELECT status, error FROM usage_events ORDER BY created_at').all();
  return { app, db, ai, send, usage, events, setNow: (iso: string) => (now = new Date(iso)) };
}

let t: ReturnType<typeof setup>;
afterEach(() => t.app.close());

describe('POST /v1/ai/requests', () => {
  // Happy path: a request returns the AI's answer, costs exactly one credit,
  // and leaves one COMMITTED row in usage_events as evidence.
  it('answers, uses one credit and records it as evidence', async () => {
    t = setup();
    const res = await t.send();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: 'answer: hi', usage: { used: 1, remaining: 2 } });
    expect(t.events()).toEqual([{ status: 'COMMITTED', error: null }]);
  });

  // Enforcement: after `limit` requests the next one is rejected with 429,
  // and the AI is never called for it (no cost for rejected requests).
  it('returns 429 once the limit is reached, without calling the AI', async () => {
    t = setup({ limit: 2 });
    await t.send();
    await t.send();
    const res = await t.send();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'QUOTA_EXCEEDED', usage: { used: 2, remaining: 0 } });
    expect(t.ai.calls).toBe(2);
  });

  // One user running out of credits must not affect anyone else.
  it('keeps limits separate per user', async () => {
    t = setup({ limit: 1 });
    expect((await t.send('alice')).statusCode).toBe(200);
    expect((await t.send('alice')).statusCode).toBe(429);
    expect((await t.send('bob')).statusCode).toBe(200);
  });

  // Race condition: 10 simultaneous requests against a limit of 3. Exactly 3 may pass, because the
  // check-and-reserve is one atomic transaction and in-flight requests count against the limit.
  it('lets exactly `limit` of many parallel requests through', async () => {
    t = setup({ limit: 3 });
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => t.send()))).map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  // AI error: the user gets 502 and is not charged, but the attempt is kept as a REFUNDED row,
  // so there is evidence of what happened.
  it('refunds the credit when the AI fails, but keeps the attempt as evidence', async () => {
    t = setup();
    t.ai.mode = 'fail';
    const res = await t.send();
    expect(res.statusCode).toBe(502);
    expect(res.json().usage).toMatchObject({ used: 0, remaining: 3 });
    expect(t.events()).toEqual([{ status: 'REFUNDED', error: 'AI_ERROR' }]);
  });

  // AI never answers: the call is cut off after the timeout, the user gets 504 and is refunded.
  it('refunds the credit when the AI times out', async () => {
    t = setup({ aiTimeoutMs: 20 });
    t.ai.mode = 'hang';
    const res = await t.send();
    expect(res.statusCode).toBe(504);
    expect(t.events()).toEqual([{ status: 'REFUNDED', error: 'AI_TIMEOUT' }]);
  });

  // Period rollover: a user who hit the limit in March can make requests again from April 1st (UTC).
  it('gives a fresh allowance in the next period', async () => {
    t = setup({ limit: 1 });
    await t.send();
    expect((await t.send()).statusCode).toBe(429);
    t.setNow('2026-04-01T00:00:00.000Z');
    expect((await t.send()).statusCode).toBe(200);
  });

  // Invalid input is rejected with 400 before any credit is reserved, so nothing is recorded or charged.
  // "non-string prompt" and "unknown field" check that bad input isn't silently coerced or stripped.
  it.each([
    ['missing user id', '', { prompt: 'hi' }],
    ['malformed user id', 'alice smith', { prompt: 'hi' }],
    ['empty prompt', 'alice', { prompt: '' }],
    ['non-string prompt', 'alice', { prompt: 42 }],
    ['unknown field', 'alice', { prompt: 'hi', extra: 1 }],
  ])('rejects %s with 400 and charges nothing', async (_case, user, body) => {
    t = setup();
    const headers = user ? { 'x-user-id': user } : {};
    const res = await t.app.inject({ method: 'POST', url: '/v1/ai/requests', headers, payload: body });
    expect(res.statusCode).toBe(400);
    expect(t.events()).toEqual([]);
  });
});

describe('GET /v1/users/:userId/usage', () => {
  // A user with no history gets the default limit, nothing used, and the current period's boundaries.
  it('reports the full allowance for a new user', async () => {
    t = setup();
    expect(await t.usage('newbie')).toEqual({
      userId: 'newbie',
      limit: 3,
      used: 0,
      remaining: 3,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
  });
});

describe('GET /v1/users and /v1/usage-events', () => {
  // The overview lists everyone with activity or a custom limit: alice (1 used, 1 refunded),
  // bob (1 used), and carol, who has a custom limit but no requests yet.
  it('lists every user with their usage, including refunds and custom limits', async () => {
    t = setup({ limit: 3 });
    await t.send('alice');
    t.ai.mode = 'fail';
    await t.send('alice');
    t.ai.mode = 'ok';
    await t.send('bob');
    await t.app.inject({ method: 'PUT', url: '/v1/users/carol/quota', payload: { limit: 10 } });

    const res = (await t.app.inject({ url: '/v1/users' })).json();
    expect(res.periodStart).toBe('2026-03-01T00:00:00.000Z');
    expect(res.users).toEqual([
      { userId: 'alice', limit: 3, customLimit: false, used: 1, refunded: 1, remaining: 2 },
      { userId: 'bob', limit: 3, customLimit: false, used: 1, refunded: 0, remaining: 2 },
      { userId: 'carol', limit: 10, customLimit: true, used: 0, refunded: 0, remaining: 10 },
    ]);
  });

  // Usage from a previous period doesn't show up in the current overview.
  it('counts only the current period', async () => {
    t = setup();
    await t.send('alice');
    t.setNow('2026-04-02T00:00:00.000Z');
    const [alice] = (await t.app.inject({ url: '/v1/users' })).json().users;
    expect(alice).toMatchObject({ userId: 'alice', used: 0, remaining: 3 });
  });

  // The raw evidence endpoint returns every row, and `?userId=` narrows it to one user.
  it('returns the raw events, optionally filtered by user', async () => {
    t = setup();
    await t.send('alice');
    await t.send('bob');

    const all = (await t.app.inject({ url: '/v1/usage-events' })).json();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ status: 'COMMITTED', period_start: '2026-03-01T00:00:00.000Z', error: null });

    const bobs = (await t.app.inject({ url: '/v1/usage-events?userId=bob' })).json();
    expect(bobs.map((e: { user_id: string }) => e.user_id)).toEqual(['bob']);
  });
});

describe('PUT / DELETE /v1/users/:userId/quota', () => {
  const setQuota = (limit: unknown, user = 'alice') =>
    t.app.inject({ method: 'PUT', url: `/v1/users/${user}/quota`, payload: { limit } });

  // A blocked user can continue as soon as their limit is raised; other users keep the default.
  it('raises a user’s limit immediately, without affecting other users', async () => {
    t = setup({ limit: 1 });
    await t.send();
    expect((await t.send()).statusCode).toBe(429);

    const res = await setQuota(3);
    expect(res.json()).toMatchObject({ limit: 3, used: 1, remaining: 2 });
    expect((await t.send()).statusCode).toBe(200);
    expect((await t.usage('bob')).limit).toBe(1);
  });

  // Lowering a limit below what's already used: new requests are blocked, `remaining` shows 0
  // (never negative), and the credits already used are not taken back.
  it('blocks new requests when lowered below current usage, without clawing back', async () => {
    t = setup({ limit: 3 });
    await t.send();
    await t.send();
    expect((await setQuota(1)).json()).toMatchObject({ limit: 1, used: 2, remaining: 0 });
    expect((await t.send()).statusCode).toBe(429);
  });

  // A limit of 0 is valid and works as a way to suspend a user.
  it('blocks everything with a limit of 0', async () => {
    t = setup();
    await setQuota(0);
    expect((await t.send()).statusCode).toBe(429);
  });

  // DELETE removes the custom limit, so the user falls back to the default.
  it('reverts to the default limit on DELETE', async () => {
    t = setup({ limit: 3 });
    await setQuota(10);
    const res = await t.app.inject({ method: 'DELETE', url: '/v1/users/alice/quota' });
    expect(res.json()).toMatchObject({ limit: 3 });
  });

  // Only whole numbers from 0 up are accepted; negative, decimal, text and null are rejected.
  it.each([[-1], [1.5], ['ten'], [null]])('rejects an invalid limit (%s)', async (limit) => {
    t = setup();
    expect((await setQuota(limit)).statusCode).toBe(400);
  });
});

describe('input validation on every endpoint', () => {
  const badUserIds = ['-1', '.', '..', '---', '_admin', 'a'.repeat(65), 'alice smith'];

  // Invalid user IDs (e.g. "-1", ".", "..", too long) are rejected everywhere a user ID is accepted, and nothing
  // is written. Usually 400; "." and ".." in a URL path are resolved before routing, so those get 404.
  it.each(badUserIds)('rejects user id "%s" on every endpoint', async (bad) => {
    t = setup();
    const id = encodeURIComponent(bad);
    const responses = await Promise.all([
      t.send(bad),
      t.app.inject({ url: `/v1/users/${id}/usage` }),
      t.app.inject({ method: 'PUT', url: `/v1/users/${id}/quota`, payload: { limit: 1 } }),
      t.app.inject({ method: 'DELETE', url: `/v1/users/${id}/quota` }),
      t.app.inject({ url: `/v1/usage-events?userId=${id}` }),
    ]);
    for (const res of responses) expect([400, 404]).toContain(res.statusCode);
    expect(t.events()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM user_quotas').get()).toEqual({ n: 0 });
  });

  // Ordinary IDs, including purely numeric ones, are still accepted.
  it.each(['1', 'alice', 'user_42', 'a.b-c'])('accepts user id "%s"', async (good) => {
    t = setup();
    expect((await t.send(good)).statusCode).toBe(200);
  });

  // The limit must be a whole number between 0 and 1,000,000,000, sent as a JSON number (not "5").
  it.each([[-1], [1_000_000_001], ['5'], [true]])('rejects quota limit %s', async (limit) => {
    t = setup();
    const res = await t.app.inject({ method: 'PUT', url: '/v1/users/alice/quota', payload: { limit } });
    expect(res.statusCode).toBe(400);
  });

  // Usage can never go negative: after lowering the limit below what's used, remaining is 0, not -2.
  it('never reports negative remaining credits', async () => {
    t = setup({ limit: 3 });
    await t.send();
    await t.send();
    await t.app.inject({ method: 'PUT', url: '/v1/users/alice/quota', payload: { limit: 0 } });
    expect(await t.usage()).toMatchObject({ limit: 0, used: 2, remaining: 0 });
  });
});

describe('Swagger', () => {
  // Every endpoint appears in the generated OpenAPI spec, so the docs at /docs are complete.
  it('publishes every endpoint in the spec', async () => {
    t = setup();
    const spec = (await t.app.inject({ url: '/docs/json' })).json();
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/v1/ai/requests',
      '/v1/usage-events',
      '/v1/users',
      '/v1/users/{userId}/quota',
      '/v1/users/{userId}/usage',
    ]);
  });
});

describe('helpers', () => {
  // Periods are calendar-aligned in UTC: December rolls over into January of the next year,
  // and an hourly period starts at the top of the hour.
  it('computes UTC period bounds, including year rollover', () => {
    expect(periodBounds(new Date('2026-12-31T23:59:59Z'), 'month')).toEqual({
      start: '2026-12-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });
    expect(periodBounds(new Date('2026-03-15T12:34:00Z'), 'hour').start).toBe('2026-03-15T12:00:00.000Z');
  });

  // withTimeout rejects with AiTimeoutError when the wrapped promise never settles.
  it('times out a slow promise', async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toBeInstanceOf(AiTimeoutError);
  });
});
