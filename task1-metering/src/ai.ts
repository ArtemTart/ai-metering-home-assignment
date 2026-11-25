export interface AiClient {
  complete(prompt: string, signal: AbortSignal): Promise<string>;
}

export class AiError extends Error {
  readonly code = 'AI_ERROR';
}

export class AiTimeoutError extends Error {
  readonly code = 'AI_TIMEOUT';
}

export interface SimulatedAiOptions {
  minDelayMs: number;
  maxDelayMs: number;
  failureRate: number;
  random?: () => number;
}

/** Stand-in for a real provider: random latency, random failures, honours cancellation. */
export function createSimulatedAi(options: SimulatedAiOptions): AiClient {
  const random = options.random ?? Math.random;

  return {
    complete(prompt, signal) {
      const delay = options.minDelayMs + random() * (options.maxDelayMs - options.minDelayMs);
      const fails = random() < options.failureRate;

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          if (fails) reject(new AiError('Simulated provider failure'));
          else resolve(`Simulated answer to: ${prompt.slice(0, 80)}`);
        }, delay);

        function onAbort() {
          clearTimeout(timer);
          reject(signal.reason);
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** Rejects with AiTimeoutError after `timeoutMs` and aborts the underlying call so a late answer is dropped. */
export async function completeWithTimeout(ai: AiClient, prompt: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AiTimeoutError(`AI call exceeded ${timeoutMs}ms`)), timeoutMs);
  try {
    return await Promise.race([
      ai.complete(prompt, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
