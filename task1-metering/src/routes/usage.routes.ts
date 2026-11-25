import type { FastifyPluginAsync } from 'fastify';
import { getUsageSchema } from '../schemas/usage.schema.js';
import type { QuotaRouteOptions, UserRoute } from '../types/index.js';

export const usageRoutes: FastifyPluginAsync<QuotaRouteOptions> = async (api, { quota }) => {
  /**
   * GET /v1/users/:userId/usage — the user's limit, credits used and remaining in the current period,
   * and when the period starts and ends. In-flight requests count as used. A user who has never made
   * a request gets their full allowance.
   */
  api.get<UserRoute>('/v1/users/:userId/usage', { schema: getUsageSchema }, async (request) =>
    quota.usage(request.params.userId),
  );
};
