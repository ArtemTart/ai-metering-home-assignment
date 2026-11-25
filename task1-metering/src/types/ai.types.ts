export type AiCall = (prompt: string) => Promise<string>;

export interface SimulatedAiOptions {
  minDelayMs: number;
  maxDelayMs: number;
  /** Probability (0–1) that a call fails. */
  failureRate: number;
}
