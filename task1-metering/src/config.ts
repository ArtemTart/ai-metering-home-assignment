import type { Config, Period } from './types/index.js';

const PERIODS: readonly Period[] = ['hour', 'day', 'month'];

/**
 * Reads and validates the environment. Any invalid value throws, so the server refuses to start
 * instead of running with e.g. a NaN credit limit (which would let every request through).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = [];

  /** Whole number in [min, max]; unset or empty uses the fallback. Rejects "abc", "5O", "1.5", "1e3". */
  const int = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^-?\d+$/.test(raw) || value < min || value > max) {
      errors.push(`${name} must be a whole number between ${min} and ${max}, got "${env[name]}"`);
      return fallback;
    }
    return value;
  };

  const fraction = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${name} must be a number between 0 and 1, got "${env[name]}"`);
      return fallback;
    }
    return value;
  };

  const period = (env.QUOTA_PERIOD?.trim() || 'month') as Period;
  if (!PERIODS.includes(period)) errors.push(`QUOTA_PERIOD must be one of ${PERIODS.join(', ')}, got "${period}"`);

  const config: Config = {
    port: int('PORT', 3000, 1, 65535),
    dbPath: env.DB_PATH?.trim() || 'data/metering.db',
    defaultLimit: int('DEFAULT_CREDIT_LIMIT', 5, 0, 1_000_000_000),
    period,
    ai: {
      minDelayMs: int('AI_MIN_DELAY_MS', 200, 0),
      maxDelayMs: int('AI_MAX_DELAY_MS', 1500, 0),
      failureRate: fraction('AI_FAILURE_RATE', 0.2),
    },
    aiTimeoutMs: int('AI_TIMEOUT_MS', 3000, 1),
  };

  if (config.ai.minDelayMs > config.ai.maxDelayMs) errors.push('AI_MIN_DELAY_MS must be <= AI_MAX_DELAY_MS');
  if (errors.length > 0) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return config;
}
