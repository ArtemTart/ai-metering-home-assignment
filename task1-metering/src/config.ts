import type { Config, Period } from './types/index.js';

const PERIODS: readonly Period[] = ['hour', 'day', 'month'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);

  const period = (env.QUOTA_PERIOD ?? 'month') as Period;
  if (!PERIODS.includes(period)) throw new Error(`Invalid QUOTA_PERIOD: ${period}`);

  return {
    port: num('PORT', 3000),
    dbPath: env.DB_PATH ?? 'data/metering.db',
    defaultLimit: num('DEFAULT_CREDIT_LIMIT', 5),
    period,
    ai: {
      minDelayMs: num('AI_MIN_DELAY_MS', 200),
      maxDelayMs: num('AI_MAX_DELAY_MS', 1500),
      failureRate: num('AI_FAILURE_RATE', 0.2),
    },
    aiTimeoutMs: num('AI_TIMEOUT_MS', 3000),
  };
}
