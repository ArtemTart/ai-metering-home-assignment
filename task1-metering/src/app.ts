import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { AiTimeoutError, withTimeout, type AiCall } from './ai.js';
import type { Quota } from './quota.js';

export interface AppDeps {
  quota: Quota;
  ai: AiCall;
  aiTimeoutMs: number;
  logger?: boolean;
}

const userId = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' } as const;

const usageSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    limit: { type: 'integer' },
    used: { type: 'integer' },
    remaining: { type: 'integer' },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
  },
} as const;

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, message: { type: 'string' }, usage: usageSchema },
} as const;

export function buildApp({ quota, ai, aiTimeoutMs, logger = false }: AppDeps) {
  const app = Fastify({
    logger,
    // Fastify's defaults silently drop unknown fields and coerce types; a billing API should reject bad input.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: 'AI Usage Metering API',
        description: 'Every AI request costs one credit. Each user has a limited number of credits per period.',
        version: '1.0.0',
      },
      // Swagger UI groups operations by tag, in this order.
      tags: [
        { name: 'AI', description: 'Metered AI requests' },
        { name: 'Usage', description: "A user's own usage" },
        { name: 'Admin', description: 'All users, raw evidence and quota management (unauthenticated in this demo)' },
      ],
    },
  });
  app.register(swaggerUi, { routePrefix: '/docs' });

  // Routes are registered after swagger so it picks them up.
  app.register(async (api) => {
    api.post<{ Headers: { 'x-user-id': string }; Body: { prompt: string } }>(
      '/v1/ai/requests',
      {
        schema: {
          tags: ['AI'],
          summary: 'Send an AI request for a user (costs 1 credit)',
          description: 'A failed or timed-out AI call is refunded, but still recorded as evidence.',
          headers: { type: 'object', required: ['x-user-id'], properties: { 'x-user-id': userId } },
          body: {
            type: 'object',
            required: ['prompt'],
            additionalProperties: false,
            properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 } },
          },
          response: {
            200: {
              description: 'AI answered; one credit used',
              type: 'object',
              properties: { requestId: { type: 'string' }, result: { type: 'string' }, usage: usageSchema },
            },
            429: { description: 'Credit limit reached for this period', ...errorSchema },
            502: { description: 'AI call failed; credit refunded', ...errorSchema },
            504: { description: 'AI call timed out; credit refunded', ...errorSchema },
          },
        },
      },
      async (request, reply) => {
        const user = request.headers['x-user-id'];
        const reservation = quota.reserve(user);
        if (!reservation.ok) {
          return reply.code(429).send({
            error: 'QUOTA_EXCEEDED',
            message: `Credit limit reached; resets at ${reservation.usage.periodEnd}`,
            usage: reservation.usage,
          });
        }

        try {
          const result = await withTimeout(ai(request.body.prompt), aiTimeoutMs);
          quota.commit(reservation.eventId);
          return { requestId: reservation.eventId, result, usage: quota.usage(user) };
        } catch (err) {
          const timedOut = err instanceof AiTimeoutError;
          quota.refund(reservation.eventId, timedOut ? 'AI_TIMEOUT' : 'AI_ERROR');
          return reply.code(timedOut ? 504 : 502).send({
            error: timedOut ? 'AI_TIMEOUT' : 'AI_ERROR',
            message: 'The AI call did not complete; your credit was refunded.',
            usage: quota.usage(user),
          });
        }
      },
    );

    api.get<{ Params: { userId: string } }>(
      '/v1/users/:userId/usage',
      {
        schema: {
          tags: ['Usage'],
          summary: "A user's current usage and remaining credits",
          params: { type: 'object', required: ['userId'], properties: { userId } },
          response: { 200: usageSchema },
        },
      },
      async (request) => quota.usage(request.params.userId),
    );

    // Admin operations. Unauthenticated in this demo; in production they would require admin auth.
    api.get(
      '/v1/users',
      {
        schema: {
          tags: ['Admin'],
          summary: 'All users with their limit and usage in the current period',
          response: {
            200: {
              type: 'object',
              properties: {
                periodStart: { type: 'string' },
                periodEnd: { type: 'string' },
                users: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      userId: { type: 'string' },
                      limit: { type: 'integer' },
                      customLimit: { type: 'boolean', description: 'true if set via PUT /quota, false if the default' },
                      used: { type: 'integer' },
                      refunded: { type: 'integer', description: 'Failed AI calls this period (not charged)' },
                      remaining: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async () => quota.listUsers(),
    );

    api.get<{ Querystring: { userId?: string } }>(
      '/v1/usage-events',
      {
        schema: {
          tags: ['Admin'],
          summary: 'Raw usage records (the evidence table), newest first, max 500',
          querystring: { type: 'object', properties: { userId } },
          response: {
            200: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  user_id: { type: 'string' },
                  status: { type: 'string', enum: ['RESERVED', 'COMMITTED', 'REFUNDED'] },
                  period_start: { type: 'string' },
                  created_at: { type: 'string' },
                  settled_at: { type: 'string', nullable: true },
                  error: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
      async (request) => quota.listEvents(request.query.userId),
    );

    api.put<{ Params: { userId: string }; Body: { limit: number } }>(
      '/v1/users/:userId/quota',
      {
        schema: {
          tags: ['Admin'],
          summary: "Set a user's credit limit (takes effect on their next request)",
          params: { type: 'object', required: ['userId'], properties: { userId } },
          body: {
            type: 'object',
            required: ['limit'],
            additionalProperties: false,
            properties: { limit: { type: 'integer', minimum: 0, maximum: 1_000_000_000 } },
          },
          response: { 200: usageSchema },
        },
      },
      async (request) => quota.setLimit(request.params.userId, request.body.limit),
    );

    api.delete<{ Params: { userId: string } }>(
      '/v1/users/:userId/quota',
      {
        schema: {
          tags: ['Admin'],
          summary: "Remove a user's custom limit, reverting to the default",
          params: { type: 'object', required: ['userId'], properties: { userId } },
          response: { 200: usageSchema },
        },
      },
      async (request) => quota.resetLimit(request.params.userId),
    );
  });

  return app;
}
