import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/database.js';
import { createQuotaService } from '../src/services/quota.service.js';

describe('loadConfig', () => {
  // With nothing set, every value falls back to a safe default.
  it('uses defaults when nothing is set', () => {
    expect(loadConfig({})).toMatchObject({ port: 3000, defaultLimit: 5, period: 'month', aiTimeoutMs: 3000 });
  });

  // Valid values are parsed, including surrounding whitespace that often sneaks into .env files.
  it('parses valid values', () => {
    const config = loadConfig({ DEFAULT_CREDIT_LIMIT: ' 10 ', QUOTA_PERIOD: 'day', AI_FAILURE_RATE: '0.5' });
    expect(config).toMatchObject({ defaultLimit: 10, period: 'day', ai: { failureRate: 0.5 } });
  });

  // A limit of 0 is a legitimate setting (everyone blocked until given a custom quota).
  it('accepts a default limit of 0', () => {
    expect(loadConfig({ DEFAULT_CREDIT_LIMIT: '0' }).defaultLimit).toBe(0);
  });

  // The original bug: these values used to become NaN (or a fraction) and silently disable the limit.
  // Now the server refuses to start and names the bad variable.
  it.each([['abc'], ['5O'], ['1.5'], ['-1'], ['1e3'], ['Infinity']])(
    'refuses to start with DEFAULT_CREDIT_LIMIT=%s',
    (value) => {
      expect(() => loadConfig({ DEFAULT_CREDIT_LIMIT: value })).toThrow(/DEFAULT_CREDIT_LIMIT/);
    },
  );

  // Other settings are validated the same way.
  it.each([
    ['QUOTA_PERIOD', 'week'],
    ['PORT', '70000'],
    ['AI_FAILURE_RATE', '2'],
    ['AI_TIMEOUT_MS', '0'],
  ])('refuses to start with %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  // All problems are reported at once, so a broken deploy is fixed in one go.
  it('reports every invalid value together', () => {
    expect(() => loadConfig({ DEFAULT_CREDIT_LIMIT: 'abc', AI_MIN_DELAY_MS: '500', AI_MAX_DELAY_MS: '100' })).toThrow(
      /DEFAULT_CREDIT_LIMIT[\s\S]*AI_MIN_DELAY_MS must be <= AI_MAX_DELAY_MS/,
    );
  });
});

describe('quota service safety net', () => {
  // Even if config validation were bypassed, the service rejects a non-integer default limit.
  it.each([[NaN], [-1], [2.5]])('rejects defaultLimit=%s', (defaultLimit) => {
    expect(() => createQuotaService(openDb(':memory:'), { defaultLimit, period: 'month' })).toThrow(/defaultLimit/);
  });

  // Fail closed: a corrupt limit stored directly in the DB (SQLite accepts text in an INTEGER column)
  // must block the user, not give them unlimited credits.
  it('blocks a user whose stored limit is corrupt', () => {
    const db = openDb(':memory:');
    const quota = createQuotaService(db, { defaultLimit: 5, period: 'month' });
    db.prepare(`INSERT INTO user_quotas (user_id, credit_limit, updated_at) VALUES ('mallory', 'abc', 'now')`).run();

    expect(quota.reserve({ userId: 'mallory', requestHash: 'h' }).kind).toBe('quota_exceeded');
  });
});
