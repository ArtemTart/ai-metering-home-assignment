import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Ajv } from 'ajv';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyServerOptions } from 'fastify';
import { AiTimeoutError, completeWithTimeout, type AiClient } from './ai.js';
import { systemClock, type Clock } from './clock.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { MeteringService, StoreUnavailableError, type Usage } from './metering.js';

export interface AppDeps {
  config: Config;
  db: Db;
  ai: AiClient;
  clock?: Clock;
  logger?: FastifyServerOptions['logger'];
  /** Delay between settlement retries; injectable so tests don't wait. */
  settleRetryDelayMs?: number;
}

const USER_ID = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' } as const;

const userHeaders = {
  type: 'object',
  required: ['x-user-id'],
  properties: {
    'x-user-id': USER_ID,
    'idempotency-key': { type: 'string', pattern: '^[\\x21-\\x7E]{1,255}$' },
  },
} as const;

const userParams = {
  type: 'object',
  required: ['userId'],
  properties: { userId: USER_ID },
} as const;

interface AiRequestRoute {
  Headers: { 'x-user-id': string; 'idempotency-key'?: string };
  Body: { prompt: string };
}

interface UserRoute {
  Params: { userId: string };
}

export function hashRequest(body: { prompt: string }): string {
  return createHash('sha256').update(JSON.stringify({ prompt: body.prompt })).digest('hex');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function buildApp(deps: AppDeps) {
  const { config, db, ai } = deps;
  const clock = deps.clock ?? systemClock;
  const retryDelayMs = deps.settleRetryDelayMs ?? 50;
  const metering = new MeteringService(db, { defaultLimit: config.defaultLimit, period: config.period }, clock);
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 });

  // Fastify's default silently strips unknown fields and coerces types. Bodies are validated strictly;
  // only URL parts and headers, which are always strings on the wire, are coerced.
  const strict = new Ajv({ coerceTypes: false, removeAdditional: false, useDefaults: true });
  const coercing = new Ajv({ coerceTypes: true, removeAdditional: false, useDefaults: true });
  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === 'body' ? strict : coercing).compile(schema));

  app.setErrorHandler<FastifyError | StoreUnavailableError>((err, request, reply) => {
    if (err instanceof StoreUnavailableError) {
      request.log.error({ err }, 'usage store unavailable');
      return reply.code(503).send({
        error: 'STORE_UNAVAILABLE',
        message: 'Usage cannot be recorded right now; the request was not processed or charged.',
      });
    }
    if (err.validation) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: err.message });
    }
    if (err.statusCode !== undefined && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'BAD_REQUEST', message: err.message });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });

  /**
   * Settlement must not be lost to a transient store error, so it is retried. If it still fails, the
   * reservation stays RESERVED and the reaper refunds it: we under-bill rather than over-bill.
   */
  async function settle(log: FastifyBaseLogger, requestId: string, fn: () => boolean): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!fn()) log.warn({ requestId }, 'reservation was already settled elsewhere (e.g. by the reaper)');
        return;
      } catch (err) {
        if (attempt === 3) {
          log.error({ err, requestId }, 'settlement failed; reservation left for the reaper');
          return;
        }
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  function usageOrNull(userId: string): Usage | null {
    try {
      return metering.getUsage(userId);
    } catch {
      return null;
    }
  }

  app.post<AiRequestRoute>(
    '/v1/ai/requests',
    {
      schema: {
        headers: userHeaders,
        body: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: false,
          properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'];
      const outcome = metering.reserve({
        userId,
        idempotencyKey: request.headers['idempotency-key'],
        requestHash: hashRequest(request.body),
      });

      switch (outcome.kind) {
        case 'quota_exceeded': {
          const retryAfter = Math.max(1, Math.ceil((Date.parse(outcome.usage.periodEnd) - clock().getTime()) / 1000));
          return reply
            .code(429)
            .header('retry-after', String(retryAfter))
            .send({ error: 'QUOTA_EXCEEDED', message: 'Credit limit reached for this period.', usage: outcome.usage });
        }
        case 'in_progress':
          return reply.code(409).send({
            error: 'REQUEST_IN_PROGRESS',
            message: 'A request with this Idempotency-Key is still being processed.',
            requestId: outcome.requestId,
          });
        case 'idempotency_mismatch':
          return reply.code(409).send({
            error: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key was already used with a different request body.',
            requestId: outcome.requestId,
          });
        case 'replay':
          return reply.header('idempotent-replayed', 'true').send({ ...outcome.response, usage: usageOrNull(userId) });
        case 'reserved':
          break;
      }

      const { requestId } = outcome;
      const started = performance.now();
      let result: string;
      try {
        result = await completeWithTimeout(ai, request.body.prompt, config.aiTimeoutMs);
      } catch (err) {
        const reason = err instanceof AiTimeoutError ? 'AI_TIMEOUT' : 'AI_ERROR';
        const latencyMs = performance.now() - started;
        request.log.warn({ err, requestId, reason }, 'AI call failed; refunding credit');
        await settle(request.log, requestId, () => metering.refund(requestId, reason, latencyMs));
        return reply.code(reason === 'AI_TIMEOUT' ? 504 : 502).send({
          error: reason,
          message: 'The AI call did not complete. Your credit was refunded.',
          requestId,
          creditRefunded: true,
          usage: usageOrNull(userId),
        });
      }

      const response = { requestId, result };
      const latencyMs = performance.now() - started;
      await settle(request.log, requestId, () => metering.commit(requestId, { latencyMs, response }));
      return { ...response, usage: usageOrNull(userId) };
    },
  );

  app.get<UserRoute>('/v1/users/:userId/usage', { schema: { params: userParams } }, async (request) =>
    metering.getUsage(request.params.userId),
  );

  app.get<UserRoute & { Querystring: { limit?: number } }>(
    '/v1/users/:userId/ledger',
    {
      schema: {
        params: userParams,
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
        },
      },
    },
    async (request) => ({ entries: metering.listLedger(request.params.userId, request.query.limit) }),
  );

  // Admin endpoint. Unauthenticated here; in production it would sit behind admin auth.
  app.put<UserRoute & { Body: { limit: number } }>(
    '/v1/users/:userId/limit',
    {
      schema: {
        params: userParams,
        body: {
          type: 'object',
          required: ['limit'],
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 0, maximum: 1_000_000_000 } },
        },
      },
    },
    async (request) => metering.setLimit(request.params.userId, request.body.limit),
  );

  app.get('/health', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'store_unavailable' });
    }
  });

  return { app, metering };
}
