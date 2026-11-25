import type { FastifyPluginAsync } from 'fastify';
import { listUsageEventsSchema, listUsersSchema, resetQuotaSchema, setQuotaSchema } from '../schemas/admin.schema.js';
import type { QuotaRouteOptions, SetQuotaRoute, UsageEventsRoute, UserRoute } from '../types/index.js';

/** Unauthenticated in this demo; in production these would require admin rights. */
export const adminRoutes: FastifyPluginAsync<QuotaRouteOptions> = async (api, { quota }) => {
  api.get('/v1/users', { schema: listUsersSchema }, async () => quota.listUsers());

  api.get<UsageEventsRoute>('/v1/usage-events', { schema: listUsageEventsSchema }, async (request) =>
    quota.listEvents(request.query.userId),
  );

  api.put<SetQuotaRoute>('/v1/users/:userId/quota', { schema: setQuotaSchema }, async (request) =>
    quota.setLimit(request.params.userId, request.body.limit),
  );

  api.delete<UserRoute>('/v1/users/:userId/quota', { schema: resetQuotaSchema }, async (request) =>
    quota.resetLimit(request.params.userId),
  );
};
