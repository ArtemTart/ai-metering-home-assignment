import { createSimulatedAi } from './ai.js';
import { buildApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { startReaper } from './reaper.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const { app, metering } = buildApp({
  config,
  db,
  ai: createSimulatedAi(config.ai),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

const stopReaper = startReaper(
  metering,
  { maxReservationAgeMs: config.aiTimeoutMs + config.reservationGraceMs, intervalMs: config.reaperIntervalMs },
  systemClock,
  app.log,
);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  stopReaper();
  // close() stops accepting connections and waits for in-flight requests, so they can settle.
  await app.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
app.log.info(
  { defaultLimit: config.defaultLimit, period: config.period, dbPath: config.dbPath },
  'metering service ready',
);
