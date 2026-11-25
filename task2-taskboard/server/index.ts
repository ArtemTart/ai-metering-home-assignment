import { buildServer } from './app.js';
import { createBoard } from './board.js';
import { loadConfig } from './config.js';
import { startSimulator } from './simulator.js';

const config = loadConfig();

const board = createBoard(
  [
    { title: 'Set up CI pipeline', assignee: 'Alice', status: 'done', priority: 'high' },
    { title: 'Design task editor', assignee: 'Bob', status: 'in_progress', priority: 'medium' },
    { title: 'Write API docs', assignee: 'Carol', status: 'todo', priority: 'low' },
    { title: 'Fix SSE reconnect', assignee: 'Dan', status: 'in_progress', priority: 'high' },
    { title: 'Add activity log', assignee: 'Alice', status: 'todo', priority: 'medium' },
    { title: 'Release v1.0', assignee: 'Bob', status: 'todo', priority: 'high' },
  ],
  { maxActivity: config.maxActivity },
);

const app = buildServer(board, { heartbeatMs: config.sseHeartbeatMs });
const stopSimulator = startSimulator(board, {
  intervalMs: config.simulatorIntervalMs,
  minTasks: config.minTasks,
  maxTasks: config.maxTasks,
});

await app.listen({ port: config.port, host: 'localhost' });
console.log(`Mock server on http://localhost:${config.port} (random change every ${config.simulatorIntervalMs} ms)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopSimulator();
    await app.close();
    process.exit(0);
  });
}
