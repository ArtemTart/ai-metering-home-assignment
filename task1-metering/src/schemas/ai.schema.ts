import { errorSchema, usageSchema, userIdSchema } from './common.schema.js';

export const aiRequestSchema = {
  tags: ['AI'],
  summary: 'Send an AI request for a user (costs 1 credit)',
  description: 'A failed or timed-out AI call is refunded, but still recorded as evidence.',
  headers: { type: 'object', required: ['x-user-id'], properties: { 'x-user-id': userIdSchema } },
  body: {
    type: 'object',
    required: ['prompt'],
    additionalProperties: false,
    properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 } },
  },
  response: {
    200: {
      description: 'AI answered; one credit used',
      type: 'object',
      properties: { requestId: { type: 'string' }, result: { type: 'string' }, usage: usageSchema },
    },
    429: { description: 'Credit limit reached for this period', ...errorSchema },
    502: { description: 'AI call failed; credit refunded', ...errorSchema },
    504: { description: 'AI call timed out; credit refunded', ...errorSchema },
  },
} as const;
