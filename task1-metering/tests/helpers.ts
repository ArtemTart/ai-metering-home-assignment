import { AiError, type AiClient } from '../src/ai.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';

export function fakeClock(startIso = '2026-03-15T12:00:00.000Z') {
  let now = new Date(startIso).getTime();
  return {
    clock: () => new Date(now),
    set(iso: string) {
      now = new Date(iso).getTime();
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

type AiMode = 'succeed' | 'fail' | 'hang' | 'manual';

/** Deterministic AI double: succeed, fail, never answer (to trigger timeouts), or wait for release(). */
export class ControllableAi implements AiClient {
  mode: AiMode = 'succeed';
  calls = 0;
  private waiting: Array<() => void> = [];

  complete(prompt: string, signal: AbortSignal): Promise<string> {
    this.calls++;
    switch (this.mode) {
      case 'succeed':
        return Promise.resolve(`answer: ${prompt}`);
      case 'fail':
        return Promise.reject(new AiError('provider exploded'));
      case 'hang':
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      case 'manual':
        return new Promise((resolve) => this.waiting.push(() => resolve(`answer: ${prompt}`)));
    }
  }

  /** Resolves every call waiting in manual mode. */
  releaseAll() {
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((resolve) => resolve());
  }

  get pending() {
    return this.waiting.length;
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    defaultLimit: 3,
    period: 'month',
    aiTimeoutMs: 50,
    reservationGraceMs: 1000,
    reaperIntervalMs: 60_000,
    ai: { minDelayMs: 0, maxDelayMs: 0, failureRate: 0 },
    ...overrides,
  };
}

export function createTestApp(options: { config?: Partial<Config>; db?: Db } = {}) {
  const config = testConfig(options.config);
  const db = options.db ?? openDb(':memory:');
  const ai = new ControllableAi();
  const time = fakeClock();
  const { app, metering } = buildApp({ config, db, ai, clock: time.clock, settleRetryDelayMs: 0 });
  return { app, metering, db, ai, time, config };
}

/** Waits until `predicate` holds, for conditions reached asynchronously inside in-flight requests. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
