import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { adminRoutes } from './routes/admin.routes.js';
import { aiRoutes } from './routes/ai.routes.js';
import { usageRoutes } from './routes/usage.routes.js';
import type { AppDeps } from './types/index.js';

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

  // Registered after swagger so it picks the routes up.
  app.register(aiRoutes, { quota, ai, aiTimeoutMs });
  app.register(usageRoutes, { quota });
  app.register(adminRoutes, { quota });

  return app;
}
