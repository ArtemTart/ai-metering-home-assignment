export const userIdSchema = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' } as const;

export const userParamsSchema = {
  type: 'object',
  required: ['userId'],
  properties: { userId: userIdSchema },
} as const;

export const usageSchema = {
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

export const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, message: { type: 'string' }, usage: usageSchema },
} as const;
