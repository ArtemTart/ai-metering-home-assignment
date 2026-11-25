import { usageSchema, userIdSchema, userParamsSchema } from './common.schema.js';

export const listUsersSchema = {
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
} as const;

export const listUsageEventsSchema = {
  tags: ['Admin'],
  summary: 'Raw usage records (the evidence table), newest first, max 500',
  querystring: { type: 'object', properties: { userId: userIdSchema } },
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
} as const;

export const setQuotaSchema = {
  tags: ['Admin'],
  summary: "Set a user's credit limit (takes effect on their next request)",
  params: userParamsSchema,
  body: {
    type: 'object',
    required: ['limit'],
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 0, maximum: 1_000_000_000, description: 'Whole number from 0 (blocked) to 1,000,000,000' },
    },
  },
  response: { 200: usageSchema },
} as const;

export const resetQuotaSchema = {
  tags: ['Admin'],
  summary: "Remove a user's custom limit, reverting to the default",
  params: userParamsSchema,
  response: { 200: usageSchema },
} as const;
