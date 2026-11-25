import { setTimeout as sleep } from 'node:timers/promises';
import type { AiCall, AiCallPolicy, SimulatedAiOptions } from '../types/index.js';

/** Stand-in for a real AI provider: random latency and occasional failures. Stops when aborted. */
export function simulatedAi({ minDelayMs, maxDelayMs, failureRate }: SimulatedAiOptions): AiCall {
  return (prompt, { signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (Math.random() < failureRate) reject(new Error('Simulated AI failure'));
        else resolve(`Simulated answer to: ${prompt.slice(0, 80)}`);
      }, delay);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export class AiTimeoutError extends Error {}

/** Rejects as soon as `signal` aborts, even if `promise` ignores the signal and never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Calls the AI with one deadline for all attempts. On timeout the in-flight call is aborted (so a real
 * provider stops working and billing), and AiTimeoutError is thrown. Failures are retried with exponential
 * backoff and jitter while time remains; the last error is thrown when retries run out.
 */
export async function callAi(
  ai: AiCall,
  prompt: string,
  { timeoutMs, retries, backoffMs }: AiCallPolicy,
  onRetry: (failedAttempt: number, error: unknown) => void = () => {},
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () => new AiTimeoutError(`AI call exceeded ${timeoutMs}ms`);

  for (let attempt = 0; ; attempt++) {
    try {
      return await untilAborted(ai(prompt, { signal }), signal);
    } catch (err) {
      if (signal.aborted) throw timedOut();
      if (attempt >= retries) throw err;
      onRetry(attempt + 1, err);
    }
    // 2^attempt × base, randomized ×0.5–1.5 so many clients retrying at once don't hit the provider in sync.
    const delay = backoffMs * 2 ** attempt * (0.5 + Math.random());
    await sleep(delay, undefined, { signal }).catch(() => {
      throw timedOut();
    });
  }
}
