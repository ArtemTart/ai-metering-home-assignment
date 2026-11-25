import Fastify from 'fastify';
import { PRIORITIES, STATUSES, TEAM, type NewTask, type ServerEvent, type TaskPatch } from '../shared/types.js';
import type { Board } from './board.js';

const fields = {
  // At least one non-space character, so "   " is not a valid title.
  title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
  assignee: { type: 'string', enum: TEAM },
  status: { type: 'string', enum: STATUSES },
  priority: { type: 'string', enum: PRIORITIES },
} as const;
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;

export function buildServer(board: Board, { heartbeatMs = 15_000 } = {}) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    // SSE connections never go idle; without this, close() would wait for them forever.
    forceCloseConnections: true,
  });

  /** Adds a task. */
  app.post<{ Body: NewTask }>(
    '/api/tasks',
    {
      schema: {
        body: { type: 'object', required: ['title', 'assignee', 'status', 'priority'], additionalProperties: false, properties: fields },
      },
    },
    async (request, reply) => reply.code(201).send(board.create({ ...request.body, title: request.body.title.trim() }, 'user')),
  );

  /** Changes only the fields sent; returns the task with its new version. 404 if it was deleted meanwhile. */
  app.patch<{ Params: { id: string }; Body: TaskPatch }>(
    '/api/tasks/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: fields },
      },
    },
    async (request, reply) => {
      const patch = request.body.title === undefined ? request.body : { ...request.body, title: request.body.title.trim() };
      const task = board.update(request.params.id, patch, 'user');
      return task ?? reply.code(404).send({ error: 'NOT_FOUND', message: 'This task no longer exists.' });
    },
  );

  /** Deletes a task. 404 if it is already gone. */
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', { schema: { params: idParams } }, async (request, reply) =>
    board.remove(request.params.id, 'user')
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'NOT_FOUND', message: 'This task no longer exists.' }),
  );

  /**
   * Server-Sent Events stream. The first event is a full snapshot, then every change as it happens.
   * The browser's EventSource reconnects automatically, and each reconnect starts with a fresh snapshot,
   * so a client that missed events while offline is brought back in sync.
   */
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event: ServerEvent) => {
      if (reply.raw.destroyed || !reply.raw.writable) throw new Error('SSE connection closed');
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Subscribe and snapshot in the same synchronous step, so no change can fall between them.
    const unsubscribe = board.subscribe(send);
    send({ type: 'snapshot', tasks: board.list(), activity: board.recentActivity() });

    // A comment line every few seconds keeps proxies from closing an idle connection.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), heartbeatMs);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
