import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/database.js';
import { simulatedAi } from './services/ai.service.js';
import { createQuotaService } from './services/quota.service.js';

const config = loadConfig();
const db = openDb(config.dbPath);

const app = buildApp({
  quota: createQuotaService(db, {
    defaultLimit: config.defaultLimit,
    period: config.period,
    dedupeWindowSeconds: config.dedupeWindowSeconds,
  }),
  ai: simulatedAi(config.ai),
  aiTimeoutMs: config.aiTimeoutMs,
  logger: true,
});

// 'localhost' listens on both IPv4 and IPv6.
await app.listen({ port: config.port, host: 'localhost' });
console.log(`Swagger UI: http://localhost:${config.port}/docs`);
