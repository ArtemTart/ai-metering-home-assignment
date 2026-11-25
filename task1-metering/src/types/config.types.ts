import type { SimulatedAiOptions } from './ai.types.js';
import type { Period } from './quota.types.js';

export interface Config {
  port: number;
  dbPath: string;
  defaultLimit: number;
  period: Period;
  dedupeWindowSeconds: number;
  ai: SimulatedAiOptions;
  aiTimeoutMs: number;
}
