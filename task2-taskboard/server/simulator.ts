import { PRIORITIES, STATUSES, TEAM, type NewTask } from '../shared/types.js';
import type { Board } from './board.js';

const TITLES = ['Fix login bug', 'Write release notes', 'Review PR', 'Update dependencies', 'Plan sprint', 'Improve onboarding'];
const MIN_TASKS = 3;
const MAX_TASKS = 15;

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;

/**
 * One random change made by "the other side" (another user, an automation): mostly edits, sometimes a new
 * task or a deletion. Deletions matter: they exercise the case where the task a user is editing disappears.
 */
export function simulateChange(board: Board, random: () => number = Math.random): void {
  const tasks = board.list();
  const roll = random();

  if ((roll < 0.1 && tasks.length < MAX_TASKS) || tasks.length < MIN_TASKS) {
    const task: NewTask = {
      title: pick(TITLES, random),
      assignee: pick(TEAM, random),
      status: 'todo',
      priority: pick(PRIORITIES, random),
    };
    board.create(task, 'server');
  } else if (roll < 0.2 && tasks.length > MIN_TASKS) {
    board.remove(pick(tasks, random).id, 'server');
  } else {
    const task = pick(tasks, random);
    const field = pick(['status', 'assignee', 'priority'] as const, random);
    const values = { status: STATUSES, assignee: TEAM, priority: PRIORITIES }[field];
    board.update(task.id, { [field]: pick(values, random) }, 'server');
  }
}

/** Starts the simulator; returns a function that stops it. */
export function startSimulator(board: Board, intervalMs: number): () => void {
  const timer = setInterval(() => simulateChange(board), intervalMs);
  return () => clearInterval(timer);
}
