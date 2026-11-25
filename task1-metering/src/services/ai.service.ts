import type { AiCall, SimulatedAiOptions } from '../types/index.js';

/** Stand-in for a real AI provider: random latency and occasional failures. */
export function simulatedAi({ minDelayMs, maxDelayMs, failureRate }: SimulatedAiOptions): AiCall {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
      setTimeout(() => {
        if (Math.random() < failureRate) reject(new Error('Simulated AI failure'));
        else resolve(`Simulated answer to: ${prompt.slice(0, 80)}`);
      }, delay);
    });
}

export class AiTimeoutError extends Error {}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiTimeoutError(`AI call exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
