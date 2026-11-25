import { buildServer } from './app.js';
import { createBoard } from './board.js';
import { startSimulator } from './simulator.js';

const PORT = Number(process.env.PORT ?? 3001);
const SIMULATOR_INTERVAL_MS = Number(process.env.SIMULATOR_INTERVAL_MS ?? 4000);

const board = createBoard([
  { title: 'Set up CI pipeline', assignee: 'Alice', status: 'done', priority: 'high' },
  { title: 'Design task editor', assignee: 'Bob', status: 'in_progress', priority: 'medium' },
  { title: 'Write API docs', assignee: 'Carol', status: 'todo', priority: 'low' },
  { title: 'Fix SSE reconnect', assignee: 'Dan', status: 'in_progress', priority: 'high' },
  { title: 'Add activity log', assignee: 'Alice', status: 'todo', priority: 'medium' },
  { title: 'Release v1.0', assignee: 'Bob', status: 'todo', priority: 'high' },
]);

const app = buildServer(board);
const stopSimulator = startSimulator(board, SIMULATOR_INTERVAL_MS);

await app.listen({ port: PORT, host: 'localhost' });
console.log(`Mock server on http://localhost:${PORT} (random change every ${SIMULATOR_INTERVAL_MS} ms)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopSimulator();
    await app.close();
    process.exit(0);
  });
}
