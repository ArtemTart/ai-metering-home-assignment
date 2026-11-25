import type { FastifyPluginAsync } from 'fastify';
import { getUsageSchema } from '../schemas/usage.schema.js';
import type { QuotaRouteOptions, UserRoute } from '../types/index.js';

export const usageRoutes: FastifyPluginAsync<QuotaRouteOptions> = async (api, { quota }) => {
  api.get<UserRoute>('/v1/users/:userId/usage', { schema: getUsageSchema }, async (request) =>
    quota.usage(request.params.userId),
  );
};
