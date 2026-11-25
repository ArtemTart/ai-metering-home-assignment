import { randomUUID } from 'node:crypto';
import type { Activity, NewTask, ServerEvent, Task, TaskPatch } from '../shared/types.js';

export interface BoardOptions {
  /** Cap on the activity feed. From MAX_ACTIVITY in .env. */
  maxActivity?: number;
  now?: () => Date;
}

/**
 * The server-side source of truth: tasks in memory, a capped activity log, and subscribers
 * (one per open SSE connection) that receive every change as it happens.
 */
export function createBoard(initial: NewTask[] = [], { maxActivity = 50, now = () => new Date() }: BoardOptions = {}) {
  const tasks = new Map<string, Task>();
  const activity: Activity[] = [];
  const subscribers = new Set<(event: ServerEvent) => void>();
  let nextActivityId = 1;

  const log = (actor: Activity['actor'], message: string): Activity => {
    const entry = { id: nextActivityId++, at: now().toISOString(), actor, message };
    activity.unshift(entry);
    activity.length = Math.min(activity.length, maxActivity);
    return entry;
  };
  const publish = (event: ServerEvent) => subscribers.forEach((send) => send(event));

  const describe = (before: Task, patch: TaskPatch) =>
    Object.entries(patch)
      .filter(([field, value]) => before[field as keyof TaskPatch] !== value)
      .map(([field, value]) => `${field} → ${value}`)
      .join(', ');

  function create(input: NewTask, actor: Activity['actor']): Task {
    const task: Task = { id: randomUUID(), ...input, version: 1, updatedAt: now().toISOString() };
    tasks.set(task.id, task);
    publish({ type: 'task.upserted', task, activity: log(actor, `created "${task.title}" (${task.assignee})`) });
    return task;
  }

  for (const input of initial) create(input, 'server');
  activity.length = 0; // the seed data is not "activity"

  return {
    list: () => [...tasks.values()],
    get: (id: string) => tasks.get(id),
    recentActivity: () => [...activity],
    create,

    /** Field-level update: only the fields in `patch` change, so concurrent edits to different fields both survive. */
    update(id: string, patch: TaskPatch, actor: Activity['actor']): Task | undefined {
      const before = tasks.get(id);
      if (!before) return undefined;
      const changes = describe(before, patch);
      if (!changes) return before; // nothing actually changed: no new version, no event
      const task: Task = { ...before, ...patch, version: before.version + 1, updatedAt: now().toISOString() };
      tasks.set(id, task);
      publish({ type: 'task.upserted', task, activity: log(actor, `"${task.title}": ${changes}`) });
      return task;
    },

    remove(id: string, actor: Activity['actor']): boolean {
      const task = tasks.get(id);
      if (!task) return false;
      tasks.delete(id);
      publish({ type: 'task.deleted', id, activity: log(actor, `deleted "${task.title}"`) });
      return true;
    },

    /** Returns an unsubscribe function. */
    subscribe(send: (event: ServerEvent) => void): () => void {
      subscribers.add(send);
      return () => subscribers.delete(send);
    },
  };
}

export type Board = ReturnType<typeof createBoard>;
