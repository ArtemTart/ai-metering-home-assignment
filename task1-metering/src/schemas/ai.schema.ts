import { errorSchema, usageSchema, userIdSchema } from './common.schema.js';

export const aiRequestSchema = {
  tags: ['AI'],
  summary: 'Send an AI request for a user (costs 1 credit)',
  description: [
    'A failed or timed-out AI call is refunded, but still recorded as evidence.',
    '',
    'Send an `Idempotency-Key` (e.g. a UUID, generated once per request and reused on retries) so retries are not',
    'charged twice: a finished request is replayed with `"replayed": true` (and header `idempotent-replayed: true`), a running one returns 409.',
  ].join('\n'),
  headers: {
    type: 'object',
    required: ['x-user-id'],
    properties: {
      'x-user-id': userIdSchema,
      'idempotency-key': {
        type: 'string',
        pattern: '^[A-Za-z0-9_-]{1,128}$',
        description: 'Optional. Same key = same request; letters, digits, _ and - (max 128)',
      },
    },
  },
  body: {
    type: 'object',
    required: ['prompt'],
    additionalProperties: false,
    properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 } },
  },
  response: {
    200: {
      description: 'AI answered; one credit used (or, if `replayed` is true, a stored answer returned for free)',
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        result: { type: 'string' },
        replayed: {
          type: 'boolean',
          description: 'true = a repeat of an earlier request: stored answer, AI not called, not charged',
        },
        usage: usageSchema,
      },
    },
    409: { description: 'Idempotency-Key is still in progress, or was used with a different prompt', ...errorSchema },
    429: { description: 'Credit limit reached for this period', ...errorSchema },
    502: { description: 'AI call failed; credit refunded', ...errorSchema },
    504: { description: 'AI call timed out; credit refunded', ...errorSchema },
  },
} as const;
