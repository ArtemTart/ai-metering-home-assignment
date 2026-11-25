import { PRIORITIES, STATUSES, TEAM, type NewTask } from '../shared/types.js';
import type { Board } from './board.js';

const TITLES = ['Fix login bug', 'Write release notes', 'Review PR', 'Update dependencies', 'Plan sprint', 'Improve onboarding'];

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;

export interface SimulatorOptions {
  minTasks: number;
  maxTasks: number;
  intervalMs: number;
  random?: () => number;
}

/**
 * One random change made by "the other side" (another user, an automation): mostly edits, sometimes a new
 * task or a deletion. Deletions matter: they exercise the case where the task a user is editing disappears.
 */
export function simulateChange(
  board: Board,
  { minTasks, maxTasks, random = Math.random }: Pick<SimulatorOptions, 'minTasks' | 'maxTasks' | 'random'>,
): void {
  const tasks = board.list();
  const roll = random();

  if ((roll < 0.1 && tasks.length < maxTasks) || tasks.length < minTasks) {
    const task: NewTask = {
      title: pick(TITLES, random),
      assignee: pick(TEAM, random),
      status: 'todo',
      priority: pick(PRIORITIES, random),
    };
    board.create(task, 'server');
  } else if (roll < 0.2 && tasks.length > minTasks) {
    board.remove(pick(tasks, random).id, 'server');
  } else {
    const task = pick(tasks, random);
    const field = pick(['status', 'assignee', 'priority'] as const, random);
    const values = { status: STATUSES, assignee: TEAM, priority: PRIORITIES }[field];
    board.update(task.id, { [field]: pick(values, random) }, 'server');
  }
}

/** Starts the simulator; returns a function that stops it. */
export function startSimulator(board: Board, options: SimulatorOptions): () => void {
  const timer = setInterval(() => simulateChange(board, options), options.intervalMs);
  return () => clearInterval(timer);
}
