import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUSES, TEAM, type Activity, type Task } from '../shared/types.js';
import { api, ApiError } from '../src/api.js';
import { useBoardStore } from '../src/stores/board.js';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  assignee: 'Alice',
  status: 'todo',
  priority: 'medium',
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
let activityId = 0;
const activity = (message = 'change'): Activity => ({ id: ++activityId, at: '2026-01-01T00:00:00.000Z', actor: 'server', message });

let store: ReturnType<typeof useBoardStore>;
beforeEach(() => {
  setActivePinia(createPinia());
  store = useBoardStore();
  vi.restoreAllMocks();
});

/** Every derived value recomputed by hand from the source tasks; the store's computed values must always match. */
function expectDerivedInSync() {
  const tasks = Object.values(store.tasks);
  for (const status of STATUSES) expect(store.countsByStatus[status]).toBe(tasks.filter((t) => t.status === status).length);
  for (const person of TEAM) {
    const theirs = tasks.filter((t) => t.assignee === person).map((t) => t.id).sort();
    expect(store.tasksByAssignee[person].map((t) => t.id).sort()).toEqual(theirs);
    expect(store.countsByAssignee[person]).toBe(theirs.length);
  }
  expect(Object.values(store.countsByStatus).reduce((a, b) => a + b, 0)).toBe(tasks.length);
}

describe('server events', () => {
  // The snapshot is the full truth: it replaces whatever the client had (e.g. after a reconnect).
  it('replaces all state with a snapshot', () => {
    store.applyEvent({ type: 'snapshot', tasks: [task('a')], activity: [] });
    store.applyEvent({ type: 'snapshot', tasks: [task('b'), task('c')], activity: [activity()] });
    expect(Object.keys(store.tasks).sort()).toEqual(['b', 'c']);
    expect(store.activity).toHaveLength(1);
  });

  // A newer version replaces the task; an older or equal one (late or duplicate delivery) is ignored.
  it('applies newer versions and ignores stale or duplicate ones', () => {
    store.applyEvent({ type: 'snapshot', tasks: [task('a', { version: 2, status: 'in_progress' })], activity: [] });
    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 1, status: 'todo' }), activity: activity() });
    expect(store.tasks.a?.status).toBe('in_progress');

    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 3, status: 'done' }), activity: activity() });
    expect(store.tasks.a?.status).toBe('done');
  });

  // Once deleted, a late update for the same task must not bring it back.
  it('does not resurrect a deleted task', () => {
    store.applyEvent({ type: 'snapshot', tasks: [task('a')], activity: [] });
    store.applyEvent({ type: 'task.deleted', id: 'a', activity: activity() });
    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 5 }), activity: activity() });
    expect(store.tasks.a).toBeUndefined();
  });

  // The same activity entry delivered twice appears once; the feed is capped at 50.
  it('deduplicates and caps the activity feed', () => {
    const entry = activity();
    store.applyEvent({ type: 'task.upserted', task: task('a'), activity: entry });
    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 2 }), activity: entry });
    expect(store.activity).toHaveLength(1);
    for (let i = 0; i < 60; i++) store.applyEvent({ type: 'task.upserted', task: task('a', { version: 3 + i }), activity: activity() });
    expect(store.activity).toHaveLength(50);
  });

  // If the server deletes the task open in the editor, the selection resolves to null (the editor shows "deleted").
  it('clears the selected task when it is deleted', () => {
    store.applyEvent({ type: 'snapshot', tasks: [task('a')], activity: [] });
    store.select('a');
    expect(store.selectedTask?.id).toBe('a');
    store.applyEvent({ type: 'task.deleted', id: 'a', activity: activity() });
    expect(store.selectedTask).toBeNull();
  });
});

describe('derived data', () => {
  // Counts and groupings follow every kind of change: snapshot, update, reassignment, delete.
  it('stays in sync through each kind of change', () => {
    store.applyEvent({ type: 'snapshot', tasks: [task('a'), task('b', { assignee: 'Bob' })], activity: [] });
    expect(store.countsByStatus).toEqual({ todo: 2, in_progress: 0, done: 0 });

    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 2, status: 'done', assignee: 'Carol' }), activity: activity() });
    expect(store.countsByStatus).toEqual({ todo: 1, in_progress: 0, done: 1 });
    expect(store.countsByAssignee).toEqual({ Alice: 0, Bob: 1, Carol: 1, Dan: 0 });

    store.applyEvent({ type: 'task.deleted', id: 'b', activity: activity() });
    expect(store.countsByAssignee.Bob).toBe(0);
    expectDerivedInSync();
  });

  // 500 random events (creates, updates, stale updates, deletes): after every single one, all derived data
  // must equal a fresh recount of the tasks.
  it('never drifts from the source data under random events', () => {
    let seed = 42;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const versions: Record<string, number> = {};

    for (let i = 0; i < 500; i++) {
      const id = `t${Math.floor(random() * 12)}`;
      if (random() < 0.15) {
        store.applyEvent({ type: 'task.deleted', id, activity: activity() });
      } else {
        versions[id] = (versions[id] ?? 0) + (random() < 0.2 ? -1 : 1); // sometimes stale
        const fields = { status: pick(STATUSES), assignee: pick(TEAM), version: versions[id]! };
        store.applyEvent({ type: 'task.upserted', task: task(id, fields), activity: activity() });
      }
      expectDerivedInSync();
    }
  });
});

describe('user actions', () => {
  beforeEach(() => store.applyEvent({ type: 'snapshot', tasks: [task('a')], activity: [] }));

  // Optimistic: the change is visible before the server answers; the server's version then replaces it.
  it('shows an update immediately, then takes the server result', async () => {
    let resolve!: (t: Task) => void;
    vi.spyOn(api, 'updateTask').mockReturnValue(new Promise((r) => (resolve = r)));

    const pending = store.updateTask('a', { status: 'done' });
    expect(store.tasks.a?.status).toBe('done');
    expect(store.isPending('a')).toBe(true);
    expect(store.countsByStatus.done).toBe(1);

    resolve(task('a', { status: 'done', version: 2 }));
    await pending;
    expect(store.tasks.a?.version).toBe(2);
    expect(store.isPending('a')).toBe(false);
  });

  // A second click while the first save is in flight is ignored — no overlapping PATCHes.
  it('ignores a second update while one is in flight', async () => {
    let resolve!: (t: Task) => void;
    const spy = vi.spyOn(api, 'updateTask').mockReturnValue(new Promise((r) => (resolve = r)));

    const first = store.updateTask('a', { status: 'done' });
    await Promise.resolve(); // let the first call set pending
    expect(store.isPending('a')).toBe(true);
    await store.updateTask('a', { status: 'in_progress' }); // ignored
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.tasks.a?.status).toBe('done');

    resolve(task('a', { status: 'done', version: 2 }));
    await first;
  });

  // The server refused: the previous value comes back and the user sees an error.
  it('rolls back a failed update', async () => {
    vi.spyOn(api, 'updateTask').mockRejectedValue(new ApiError(500, 'boom'));
    await store.updateTask('a', { status: 'done' });
    expect(store.tasks.a?.status).toBe('todo');
    expect(store.lastError).toMatch(/Could not save/);
  });

  // ...but if the server pushed a newer version while the request was in flight, that version wins.
  it('does not roll back over a newer server version', async () => {
    let reject!: (e: Error) => void;
    vi.spyOn(api, 'updateTask').mockReturnValue(new Promise((_, r) => (reject = r)));
    const pending = store.updateTask('a', { status: 'done' });

    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 2, status: 'in_progress' }), activity: activity() });
    reject(new ApiError(500, 'boom'));
    await pending;
    expect(store.tasks.a?.status).toBe('in_progress');
  });

  // Editing a task someone else just deleted: it disappears and the user is told why.
  it('removes a task that the server says no longer exists', async () => {
    vi.spyOn(api, 'updateTask').mockRejectedValue(new ApiError(404, 'gone'));
    await store.updateTask('a', { status: 'done' });
    expect(store.tasks.a).toBeUndefined();
    expect(store.lastError).toMatch(/deleted by someone else/);
  });

  // Delete is optimistic too, and restored if the server refuses.
  it('deletes immediately and restores on failure', async () => {
    vi.spyOn(api, 'deleteTask').mockRejectedValue(new ApiError(500, 'boom'));
    const pending = store.deleteTask('a');
    expect(store.tasks.a).toBeUndefined();
    await pending;
    expect(store.tasks.a?.title).toBe('Task a');
  });

  // Deleting something that is already gone is not an error.
  it('treats a 404 on delete as success', async () => {
    vi.spyOn(api, 'deleteTask').mockRejectedValue(new ApiError(404, 'gone'));
    await store.deleteTask('a');
    expect(store.tasks.a).toBeUndefined();
    expect(store.lastError).toBeNull();
  });

  // A created task is added from the server response; the SSE echo of the same version is then ignored.
  it('adds a created task once', async () => {
    const created = task('b', { title: 'New' });
    vi.spyOn(api, 'createTask').mockResolvedValue(created);
    await store.createTask({ title: 'New', assignee: 'Alice', status: 'todo', priority: 'low' });
    store.applyEvent({ type: 'task.upserted', task: created, activity: activity() });
    expect(store.taskList.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });
});
