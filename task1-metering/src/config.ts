import type { Period } from './period.js';

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  defaultLimit: number;
  period: Period;
  aiTimeoutMs: number;
  /** Extra time after the AI timeout before an unsettled reservation is considered orphaned. */
  reservationGraceMs: number;
  reaperIntervalMs: number;
  ai: {
    minDelayMs: number;
    maxDelayMs: number;
    failureRate: number;
  };
}

const PERIODS: readonly Period[] = ['hour', 'day', 'month'];

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function rate(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const period = (env.QUOTA_PERIOD ?? 'month') as Period;
  if (!PERIODS.includes(period)) {
    throw new Error(`QUOTA_PERIOD must be one of ${PERIODS.join(', ')}, got "${period}"`);
  }

  const config: Config = {
    port: int(env, 'PORT', 3000, 1),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.DB_PATH ?? 'data/metering.db',
    defaultLimit: int(env, 'DEFAULT_CREDIT_LIMIT', 100),
    period,
    aiTimeoutMs: int(env, 'AI_TIMEOUT_MS', 3000, 1),
    reservationGraceMs: int(env, 'RESERVATION_GRACE_MS', 30_000),
    reaperIntervalMs: int(env, 'REAPER_INTERVAL_MS', 10_000, 1),
    ai: {
      minDelayMs: int(env, 'AI_MIN_DELAY_MS', 200),
      maxDelayMs: int(env, 'AI_MAX_DELAY_MS', 1500),
      failureRate: rate(env, 'AI_FAILURE_RATE', 0.1),
    },
  };

  if (config.ai.minDelayMs > config.ai.maxDelayMs) {
    throw new Error('AI_MIN_DELAY_MS must be <= AI_MAX_DELAY_MS');
  }
  return config;
}
