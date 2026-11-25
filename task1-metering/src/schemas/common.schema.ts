/** 1–64 chars of letters, digits, `_`, `.`, `-`; must start with a letter or digit, so "-1", "." and ".." are rejected. */
export const userIdSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$',
  description: 'Letters, digits, _ . - (max 64), starting with a letter or digit',
} as const;

const count = { type: 'integer', minimum: 0 } as const;

export const userParamsSchema = {
  type: 'object',
  required: ['userId'],
  properties: { userId: userIdSchema },
} as const;

export const usageSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    limit: count,
    used: count,
    remaining: count,
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
  },
} as const;

export const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, message: { type: 'string' }, usage: usageSchema },
} as const;
