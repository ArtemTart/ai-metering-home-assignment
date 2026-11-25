/** Calls the AI provider. Implementations should stop work and reject when `signal` is aborted. */
export type AiCall = (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;

export interface SimulatedAiOptions {
  minDelayMs: number;
  maxDelayMs: number;
  /** Probability (0–1) that a call fails. */
  failureRate: number;
}

export interface AiCallPolicy {
  /** Deadline for the whole call, retries included. */
  timeoutMs: number;
  /** Extra attempts after a failure (0 = no retry). */
  retries: number;
  /** Base backoff; doubles per attempt, with jitter. */
  backoffMs: number;
}
