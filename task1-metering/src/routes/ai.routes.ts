import type { FastifyPluginAsync } from 'fastify';
import { aiRequestSchema } from '../schemas/ai.schema.js';
import { AiTimeoutError, withTimeout } from '../services/ai.service.js';
import type { AiRequestRoute, AiRouteOptions } from '../types/index.js';

export const aiRoutes: FastifyPluginAsync<AiRouteOptions> = async (api, { quota, ai, aiTimeoutMs }) => {
  /**
   * POST /v1/ai/requests — sends a prompt to the (simulated) AI on behalf of the user in `x-user-id`.
   * Reserves one credit first; if the user has none left, returns 429 without calling the AI.
   * On success the credit is committed (200). If the AI fails (502) or times out (504), the credit is
   * refunded, but the attempt stays in usage_events as evidence.
   */
  api.post<AiRequestRoute>('/v1/ai/requests', { schema: aiRequestSchema }, async (request, reply) => {
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
      const reason = err instanceof AiTimeoutError ? 'AI_TIMEOUT' : 'AI_ERROR';
      quota.refund(reservation.eventId, reason);
      return reply.code(reason === 'AI_TIMEOUT' ? 504 : 502).send({
        error: reason,
        message: 'The AI call did not complete; your credit was refunded.',
        usage: quota.usage(user),
      });
    }
  });
};
