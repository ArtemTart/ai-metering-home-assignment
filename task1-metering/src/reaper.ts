import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from './clock.js';
import type { MeteringService } from './metering.js';

export interface ReaperOptions {
  /** Reservations older than this have outlived any live request and are treated as orphaned. */
  maxReservationAgeMs: number;
  intervalMs: number;
}

/** Refunds reservations left behind by a crashed instance. Returns a stop function. */
export function startReaper(
  metering: MeteringService,
  options: ReaperOptions,
  clock: Clock,
  log: FastifyBaseLogger,
): () => void {
  const tick = () => {
    try {
      const refunded = metering.expireReservationsOlderThan(new Date(clock().getTime() - options.maxReservationAgeMs));
      if (refunded > 0) log.warn({ refunded }, 'refunded orphaned reservations');
    } catch (err) {
      log.error({ err }, 'reaper run failed');
    }
  };

  tick();
  const timer = setInterval(tick, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
