import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError } from '../src/metering.js';
import { startReaper } from '../src/reaper.js';
import { createTestApp, waitFor } from './helpers.js';

type TestApp = ReturnType<typeof createTestApp>;

function aiRequest(t: TestApp, opts: { user?: string; key?: string; prompt?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.user !== '') headers['x-user-id'] = opts.user ?? 'alice';
  if (opts.key) headers['idempotency-key'] = opts.key;
  return t.app.inject({
    method: 'POST',
    url: '/v1/ai/requests',
    headers,
    payload: (opts.body ?? { prompt: opts.prompt ?? 'hello' }) as object,
  });
}

const usage = (t: TestApp, user = 'alice') => t.app.inject({ method: 'GET', url: `/v1/users/${user}/usage` });

describe('AI request API', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.app.close();
  });

  it('serves a request, charges one credit and records it as committed evidence', async () => {
    t = createTestApp();
    const res = await aiRequest(t, { prompt: 'what is 2+2' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ result: 'answer: what is 2+2', usage: { used: 1, reserved: 0, remaining: 2 } });
    expect(t.metering.listLedger('alice')).toEqual([
      expect.objectContaining({ id: body.requestId, status: 'COMMITTED', error_code: null }),
    ]);
  });

  it('returns 429 with Retry-After once the limit is reached, without calling the AI', async () => {
    t = createTestApp();
    for (let i = 0; i < 3; i++) expect((await aiRequest(t)).statusCode).toBe(200);

    const res = await aiRequest(t);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'QUOTA_EXCEEDED', usage: { used: 3, remaining: 0 } });
    // Clock is 2026-03-15T12:00Z, the period ends 2026-04-01T00:00Z.
    expect(res.headers['retry-after']).toBe(String((16 * 24 + 12) * 3600));
    expect(t.ai.calls).toBe(3);
  });

  it('refunds the credit when the AI fails (502)', async () => {
    t = createTestApp();
    t.ai.mode = 'fail';

    const res = await aiRequest(t);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'AI_ERROR', creditRefunded: true, usage: { used: 0, remaining: 3 } });
    expect(t.metering.listLedger('alice')[0]).toMatchObject({ status: 'REFUNDED', error_code: 'AI_ERROR' });
  });

  it('refunds the credit when the AI times out (504)', async () => {
    t = createTestApp({ config: { aiTimeoutMs: 20 } });
    t.ai.mode = 'hang';

    const res = await aiRequest(t);
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: 'AI_TIMEOUT', creditRefunded: true, usage: { remaining: 3 } });
    expect(t.metering.listLedger('alice')[0]).toMatchObject({ status: 'REFUNDED', error_code: 'AI_TIMEOUT' });
  });

  it('lets exactly `limit` of many parallel requests through', async () => {
    t = createTestApp();
    t.ai.mode = 'manual';

    const inFlight = Array.from({ length: 10 }, () => aiRequest(t));
    await waitFor(() => t.ai.pending === 3);
    t.ai.releaseAll();
    const statuses = (await Promise.all(inFlight)).map((r) => r.statusCode).sort();

    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
    expect(t.ai.calls).toBe(3);
    expect((await usage(t)).json()).toMatchObject({ used: 3, reserved: 0, remaining: 0 });
  });

  describe('idempotency', () => {
    it('replays a retried request without charging or calling the AI again', async () => {
      t = createTestApp();
      const first = await aiRequest(t, { key: 'req-1' });
      const retry = await aiRequest(t, { key: 'req-1' });

      expect(retry.statusCode).toBe(200);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.json().requestId).toBe(first.json().requestId);
      expect(retry.json().result).toBe(first.json().result);
      expect(t.ai.calls).toBe(1);
      expect(retry.json().usage.used).toBe(1);
    });

    it('rejects the same key with a different body (409)', async () => {
      t = createTestApp();
      await aiRequest(t, { key: 'req-1', prompt: 'a' });
      const res = await aiRequest(t, { key: 'req-1', prompt: 'b' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('rejects a duplicate while the original is still in flight (409)', async () => {
      t = createTestApp();
      t.ai.mode = 'manual';
      const original = aiRequest(t, { key: 'req-1' });
      await waitFor(() => t.ai.pending === 1);

      const duplicate = await aiRequest(t, { key: 'req-1' });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error).toBe('REQUEST_IN_PROGRESS');

      t.ai.releaseAll();
      expect((await original).statusCode).toBe(200);
      expect(t.ai.calls).toBe(1);
    });

    it('lets a client retry with the same key after a failure', async () => {
      t = createTestApp();
      t.ai.mode = 'fail';
      expect((await aiRequest(t, { key: 'req-1' })).statusCode).toBe(502);

      t.ai.mode = 'succeed';
      const retry = await aiRequest(t, { key: 'req-1' });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().usage).toMatchObject({ used: 1, remaining: 2 });
    });
  });

  describe('validation (rejected before any credit is reserved)', () => {
    it.each([
      ['missing user id', { user: '' }],
      ['malformed user id', { user: 'alice smith' }],
      ['empty prompt', { prompt: '' }],
      ['missing prompt', { body: {} }],
      ['unknown field', { body: { prompt: 'x', model: 'gpt' } }],
      ['non-string prompt', { body: { prompt: 42 } }],
      ['bad idempotency key', { key: 'has spaces' }],
    ])('rejects %s with 400', async (_name, opts) => {
      t = createTestApp();
      const res = await aiRequest(t, opts);
      expect(res.statusCode).toBe(400);
      expect(t.metering.listLedger('alice')).toHaveLength(0);
    });

    it('rejects an oversized body with 413', async () => {
      t = createTestApp();
      const res = await aiRequest(t, { prompt: 'x'.repeat(20_000) });
      expect(res.statusCode).toBe(413);
    });
  });

  describe('failure handling', () => {
    it('fails closed with 503 when the store is down, without calling the AI', async () => {
      t = createTestApp();
      t.db.close();

      const res = await aiRequest(t);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('STORE_UNAVAILABLE');
      expect(t.ai.calls).toBe(0);
      expect((await usage(t)).statusCode).toBe(503);
      expect((await t.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(503);
    });

    it('still returns the result if recording success fails; the reaper later refunds it', async () => {
      t = createTestApp();
      const commit = vi.spyOn(t.metering, 'commit').mockImplementation(() => {
        throw new StoreUnavailableError(new Error('disk full'));
      });

      const res = await aiRequest(t);
      expect(res.statusCode).toBe(200);
      expect(commit).toHaveBeenCalledTimes(3);
      expect(t.metering.listLedger('alice')[0]?.status).toBe('RESERVED');

      commit.mockRestore();
      const maxReservationAgeMs = t.config.aiTimeoutMs + t.config.reservationGraceMs;
      t.time.advance(maxReservationAgeMs + 1);
      const stopReaper = startReaper(t.metering, { maxReservationAgeMs, intervalMs: 60_000 }, t.time.clock, t.app.log);
      stopReaper();

      expect(t.metering.listLedger('alice')[0]).toMatchObject({ status: 'REFUNDED', error_code: 'RESERVATION_EXPIRED' });
      expect((await usage(t)).json()).toMatchObject({ used: 0, reserved: 0, remaining: 3 });
    });

    it('recovers when settlement succeeds on a retry', async () => {
      t = createTestApp();
      const realCommit = t.metering.commit.bind(t.metering);
      vi.spyOn(t.metering, 'commit')
        .mockImplementationOnce(() => {
          throw new StoreUnavailableError(new Error('busy'));
        })
        .mockImplementation(realCommit);

      const res = await aiRequest(t);
      expect(res.statusCode).toBe(200);
      expect(res.json().usage).toMatchObject({ used: 1, reserved: 0 });
    });
  });
});

describe('usage, limit and ledger endpoints', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.app.close();
  });

  it('reports a full allowance for a user who has never made a request', async () => {
    t = createTestApp();
    expect((await usage(t, 'newbie')).json()).toEqual({
      userId: 'newbie',
      limit: 3,
      used: 0,
      reserved: 0,
      remaining: 3,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
  });

  it('enforces a per-user limit override', async () => {
    t = createTestApp();
    const put = await t.app.inject({ method: 'PUT', url: '/v1/users/alice/limit', payload: { limit: 1 } });
    expect(put.json()).toMatchObject({ limit: 1, remaining: 1 });

    expect((await aiRequest(t)).statusCode).toBe(200);
    expect((await aiRequest(t)).statusCode).toBe(429);
    expect((await aiRequest(t, { user: 'bob' })).statusCode).toBe(200);
  });

  it.each([[-1], [1.5], ['ten']])('rejects an invalid limit (%s)', async (limit) => {
    t = createTestApp();
    const res = await t.app.inject({ method: 'PUT', url: '/v1/users/alice/limit', payload: { limit } });
    expect(res.statusCode).toBe(400);
  });

  it('publishes an OpenAPI spec covering every endpoint', async () => {
    t = createTestApp();
    const spec = (await t.app.inject({ method: 'GET', url: '/docs/json' })).json();
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/health',
      '/v1/ai/requests',
      '/v1/users/{userId}/ledger',
      '/v1/users/{userId}/limit',
      '/v1/users/{userId}/usage',
    ]);
  });

  it('exposes the ledger for audits, including refunded attempts', async () => {
    t = createTestApp();
    await aiRequest(t);
    t.ai.mode = 'fail';
    await aiRequest(t);

    const res = await t.app.inject({ method: 'GET', url: '/v1/users/alice/ledger' });
    expect(res.json().entries.map((e: { status: string }) => e.status).sort()).toEqual(['COMMITTED', 'REFUNDED']);
  });
});
