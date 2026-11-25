import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { aiRequestSchema } from '../schemas/ai.schema.js';
import { AiTimeoutError, withTimeout } from '../services/ai.service.js';
import type { AiRequestRoute, AiRouteOptions } from '../types/index.js';

const hashPrompt = (prompt: string) => createHash('sha256').update(prompt).digest('hex');

export const aiRoutes: FastifyPluginAsync<AiRouteOptions> = async (api, { quota, ai, aiTimeoutMs }) => {
  /**
   * POST /v1/ai/requests — sends a prompt to the (simulated) AI on behalf of the user in `x-user-id`.
   * Reserves one credit first; if the user has none left, returns 429 without calling the AI.
   * On success the credit is committed (200). If the AI fails (502) or times out (504), the credit is
   * refunded, but the attempt stays in usage_events as evidence.
   * With an `Idempotency-Key`, a repeat of a finished request returns the stored answer without charging,
   * a repeat of a running one returns 409, and reusing the key for a different prompt returns 409.
   * Without a key, the same prompt from the same user within DEDUPE_WINDOW_SECONDS is treated the same way.
   */
  api.post<AiRequestRoute>('/v1/ai/requests', { schema: aiRequestSchema }, async (request, reply) => {
    const user = request.headers['x-user-id'];
    const reservation = quota.reserve({
      userId: user,
      idempotencyKey: request.headers['idempotency-key'],
      requestHash: hashPrompt(request.body.prompt),
    });

    switch (reservation.kind) {
      case 'quota_exceeded':
        return reply.code(429).send({
          error: 'QUOTA_EXCEEDED',
          message: `Credit limit reached; resets at ${reservation.usage.periodEnd}`,
          usage: reservation.usage,
        });
      case 'replay':
        return reply.header('idempotent-replayed', 'true').send({ ...reservation.response, usage: quota.usage(user) });
      case 'in_progress':
        return reply.code(409).send({
          error: 'REQUEST_IN_PROGRESS',
          message: 'The same request is still running; retry shortly.',
        });
      case 'key_reused':
        return reply.code(409).send({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This Idempotency-Key was already used for a different prompt.',
        });
    }

    const { eventId } = reservation;
    let result: string;
    try {
      result = await withTimeout(ai(request.body.prompt), aiTimeoutMs);
    } catch (err) {
      const reason = err instanceof AiTimeoutError ? 'AI_TIMEOUT' : 'AI_ERROR';
      quota.refund(eventId, reason);
      return reply.code(reason === 'AI_TIMEOUT' ? 504 : 502).send({
        error: reason,
        message: 'The AI call did not complete; your credit was refunded.',
        usage: quota.usage(user),
      });
    }

    const response = { requestId: eventId, result };
    quota.commit(eventId, response);
    return { ...response, usage: quota.usage(user) };
  });
};
