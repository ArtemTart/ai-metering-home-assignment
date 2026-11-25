import type { FastifyPluginAsync } from 'fastify';
import { listUsageEventsSchema, listUsersSchema, resetQuotaSchema, setQuotaSchema } from '../schemas/admin.schema.js';
import type { QuotaRouteOptions, SetQuotaRoute, UsageEventsRoute, UserRoute } from '../types/index.js';

/** Unauthenticated in this demo; in production these would require admin rights. */
export const adminRoutes: FastifyPluginAsync<QuotaRouteOptions> = async (api, { quota }) => {
  /**
   * GET /v1/users — every user who has made a request or has a custom limit, with their limit,
   * used, refunded and remaining credits for the current period. Computed in a single query.
   */
  api.get('/v1/users', { schema: listUsersSchema }, async () => quota.listUsers());

  /**
   * GET /v1/usage-events?userId= — raw rows of the usage_events evidence table, newest first,
   * at most 500. Includes refunded attempts. Filter by `userId` to see one user's history.
   */
  api.get<UsageEventsRoute>('/v1/usage-events', { schema: listUsageEventsSchema }, async (request) =>
    quota.listEvents(request.query.userId),
  );

  /**
   * PUT /v1/users/:userId/quota — sets a custom credit limit for the user, stored in user_quotas.
   * Takes effect on their next request. Lowering it below current usage blocks new requests but
   * doesn't claw back credits already used. Returns the user's updated usage.
   */
  api.put<SetQuotaRoute>('/v1/users/:userId/quota', { schema: setQuotaSchema }, async (request) =>
    quota.setLimit(request.params.userId, request.body.limit),
  );

  /**
   * DELETE /v1/users/:userId/quota — removes the user's custom limit, so DEFAULT_CREDIT_LIMIT
   * applies again. Returns the user's updated usage.
   */
  api.delete<UserRoute>('/v1/users/:userId/quota', { schema: resetQuotaSchema }, async (request) =>
    quota.resetLimit(request.params.userId),
  );
};
