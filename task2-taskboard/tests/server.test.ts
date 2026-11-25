// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/types.js';
import { buildServer } from '../server/app.js';
import { createBoard } from '../server/board.js';
import { simulateChange } from '../server/simulator.js';

const seed = [
  { title: 'One', assignee: 'Alice', status: 'todo', priority: 'low' },
  { title: 'Two', assignee: 'Bob', status: 'done', priority: 'high' },
  { title: 'Three', assignee: 'Carol', status: 'todo', priority: 'medium' },
  { title: 'Four', assignee: 'Dan', status: 'in_progress', priority: 'medium' },
] as const;

function setup() {
  const board = createBoard([...seed]);
  const events: ServerEvent[] = [];
  board.subscribe((e) => events.push(e));
  const app = buildServer(board);
  return { board, events, app };
}
let t: ReturnType<typeof setup>;
afterEach(() => t?.app.close());

describe('REST API', () => {
  // Creating a task returns it with an ID and version 1, and broadcasts it to subscribers.
  it('creates a task and broadcasts it', async () => {
    t = setup();
    const res = await t.app.inject({ method: 'POST', url: '/api/tasks', payload: { title: ' New ', assignee: 'Bob', status: 'todo', priority: 'low' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: 'New', version: 1 });
    expect(t.events[0]).toMatchObject({ type: 'task.upserted', activity: { actor: 'user' } });
  });

  // Invalid input is rejected: blank title, unknown person or status, unknown fields, wrong types, empty patch.
  it.each([
    ['POST', { title: '   ', assignee: 'Bob', status: 'todo', priority: 'low' }],
    ['POST', { title: 'x', assignee: 'Eve', status: 'todo', priority: 'low' }],
    ['POST', { title: 'x', assignee: 'Bob', status: 'blocked', priority: 'low' }],
    ['POST', { title: 'x', assignee: 'Bob', status: 'todo', priority: 'low', extra: 1 }],
    ['PATCH', { title: 42 }],
    ['PATCH', {}],
  ])('rejects invalid input (%s %j)', async (method, payload) => {
    t = setup();
    const id = t.board.list()[0]!.id;
    const url = method === 'POST' ? '/api/tasks' : `/api/tasks/${id}`;
    expect((await t.app.inject({ method: method as 'POST' | 'PATCH', url, payload })).statusCode).toBe(400);
    expect(t.events).toHaveLength(0);
  });

  // A patch changes only the fields it contains, so a concurrent change to another field is not lost.
  it('updates only the fields sent and bumps the version', async () => {
    t = setup();
    const before = t.board.list()[0]!;
    t.board.update(before.id, { priority: 'high' }, 'server'); // someone else's change
    const res = await t.app.inject({ method: 'PATCH', url: `/api/tasks/${before.id}`, payload: { status: 'done' } });
    expect(res.json()).toMatchObject({ status: 'done', priority: 'high', version: 3 });
  });

  // Setting a field to the value it already has is not a change: no new version, no event.
  it('ignores a patch that changes nothing', async () => {
    t = setup();
    const before = t.board.list()[0]!;
    const res = await t.app.inject({ method: 'PATCH', url: `/api/tasks/${before.id}`, payload: { status: before.status } });
    expect(res.json().version).toBe(before.version);
    expect(t.events).toHaveLength(0);
  });

  // Editing or deleting a task that no longer exists returns 404.
  it('returns 404 for a deleted task', async () => {
    t = setup();
    const id = t.board.list()[0]!.id;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/tasks/${id}` })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/tasks/${id}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { status: 'done' } })).statusCode).toBe(404);
  });
});

describe('SSE stream', () => {
  // A new connection first receives the full snapshot, then live changes.
  it('sends a snapshot, then changes', async () => {
    t = setup();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as { port: number };
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const read = async () => {
      let text = '';
      while (!text.includes('\n\n')) text += decoder.decode((await reader.read()).value);
      return JSON.parse(text.replace(/^data: /, '').trim()) as ServerEvent;
    };

    const snapshot = await read();
    expect(snapshot).toMatchObject({ type: 'snapshot' });
    expect(snapshot.type === 'snapshot' && snapshot.tasks).toHaveLength(4);

    t.board.update(t.board.list()[0]!.id, { status: 'done' }, 'server');
    expect(await read()).toMatchObject({ type: 'task.upserted', task: { status: 'done' } });
    controller.abort();
  });
});

describe('simulator', () => {
  // The simulated "other side" keeps changing tasks, and every change is broadcast like a user's.
  it('makes random changes that are broadcast', () => {
    t = setup();
    for (let i = 0; i < 100; i++) simulateChange(t.board);
    expect(t.events.length).toBeGreaterThan(50);
    expect(t.events.every((e) => e.type !== 'snapshot' && e.activity.actor === 'server')).toBe(true);
  });

  // It never deletes the board down to nothing.
  it('keeps at least 3 tasks', () => {
    t = setup();
    for (let i = 0; i < 500; i++) {
      simulateChange(t.board);
      expect(t.board.list().length).toBeGreaterThanOrEqual(3);
    }
  });
});
