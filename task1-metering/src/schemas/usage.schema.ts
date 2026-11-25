import { usageSchema, userParamsSchema } from './common.schema.js';

export const getUsageSchema = {
  tags: ['Usage'],
  summary: "A user's current usage and remaining credits",
  params: userParamsSchema,
  response: { 200: usageSchema },
} as const;
