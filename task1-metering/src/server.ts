import { simulatedAi } from './ai.js';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { createQuota, type Period } from './quota.js';

const env = process.env;
const num = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);

const period = (env.QUOTA_PERIOD ?? 'month') as Period;
if (!['hour', 'day', 'month'].includes(period)) throw new Error(`Invalid QUOTA_PERIOD: ${period}`);

const db = openDb(env.DB_PATH ?? 'data/metering.db');
const app = buildApp({
  quota: createQuota(db, { limit: num('DEFAULT_CREDIT_LIMIT', 5), period }),
  ai: simulatedAi({
    minDelayMs: num('AI_MIN_DELAY_MS', 200),
    maxDelayMs: num('AI_MAX_DELAY_MS', 1500),
    failureRate: num('AI_FAILURE_RATE', 0.2),
  }),
  aiTimeoutMs: num('AI_TIMEOUT_MS', 3000),
  logger: true,
});

// 'localhost' listens on both IPv4 and IPv6.
await app.listen({ port: num('PORT', 3000), host: 'localhost' });
console.log(`Swagger UI: http://localhost:${num('PORT', 3000)}/docs`);
