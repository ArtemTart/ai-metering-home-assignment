import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/database.js';
import { simulatedAi } from './services/ai.service.js';
import { createQuotaService } from './services/quota.service.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const quota = createQuotaService(db, {
  defaultLimit: config.defaultLimit,
  period: config.period,
  dedupeWindowSeconds: config.dedupeWindowSeconds,
});

const app = buildApp({
  quota,
  ai: simulatedAi(config.ai),
  aiTimeoutMs: config.aiTimeoutMs,
  aiRetries: config.aiRetries,
  aiBackoffMs: config.aiBackoffMs,
  logger: true,
});

// A live request always settles within the AI timeout, so anything RESERVED for longer was orphaned by a crash.
const staleAfterMs = config.aiTimeoutMs + 30_000;
const sweep = () => {
  const refunded = quota.refundStale(staleAfterMs);
  if (refunded > 0) app.log.warn({ refunded }, 'Refunded reservations left by a crashed process');
};
sweep();
const sweeper = setInterval(sweep, 30_000);

// 'localhost' listens on both IPv4 and IPv6.
await app.listen({ port: config.port, host: 'localhost' });
console.log(`Swagger UI: http://localhost:${config.port}/docs`);

// Graceful shutdown: stop accepting requests, let in-flight AI calls finish and settle their credit, then close the DB.
// Without this, Ctrl+C or a deploy leaves RESERVED rows behind.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down: waiting for in-flight requests');
  const force = setTimeout(() => {
    app.log.error('In-flight requests did not finish in time; exiting anyway');
    process.exit(1);
  }, config.aiTimeoutMs + 5_000);
  force.unref();

  clearInterval(sweeper);
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
