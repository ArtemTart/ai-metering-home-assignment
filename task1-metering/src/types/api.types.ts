import type { QuotaService } from '../services/quota.service.js';
import type { AiCall, AiCallPolicy } from './ai.types.js';

export interface AppDeps {
  quota: QuotaService;
  ai: AiCall;
  aiTimeoutMs: number;
  /** Retries after a failed AI call, within aiTimeoutMs. Default 0. */
  aiRetries?: number;
  /** Base retry backoff. Default 100. */
  aiBackoffMs?: number;
  logger?: boolean;
}

/** Options passed to the route plugins. */
export interface QuotaRouteOptions {
  quota: QuotaService;
}

export interface AiRouteOptions extends QuotaRouteOptions {
  ai: AiCall;
  aiPolicy: AiCallPolicy;
}

// Request shapes, used as Fastify route generics.

export interface UserParams {
  userId: string;
}

export interface AiRequestRoute {
  Headers: { 'x-user-id': string; 'idempotency-key'?: string };
  Body: { prompt: string };
}

export interface UserRoute {
  Params: UserParams;
}

export interface SetQuotaRoute {
  Params: UserParams;
  Body: { limit: number };
}

export interface UsageEventsRoute {
  Querystring: { userId?: string };
}
