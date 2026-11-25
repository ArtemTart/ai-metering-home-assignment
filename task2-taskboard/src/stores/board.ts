import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { PRIORITIES, STATUSES, TEAM } from '../../shared/types.js';
import type { Activity, Assignee, NewTask, ServerEvent, Status, Task, TaskPatch } from '../../shared/types.js';
import { api, ApiError } from '../api.js';

/** Mirrors the server's MAX_ACTIVITY (.env). The server already caps the feed; this is a client-side safety net. */
const MAX_ACTIVITY = Number(import.meta.env.VITE_MAX_ACTIVITY ?? 50);

/** High priority first, then alphabetically, so the order is stable while tasks change. */
const byPriorityThenTitle = (a: Task, b: Task) =>
  PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || a.title.localeCompare(b.title);

/**
 * The single source of truth for the whole UI. Every component reads from here and changes data only
 * through these actions; user edits and server pushes go through the same functions.
 *
 * Only source data is stored (tasks, activity). Counts and groupings are `computed` from it, so they can
 * never disagree with the tasks: there is no second copy to forget to update.
 */
export const useBoardStore = defineStore('board', () => {
  // ---- Source state ----
  const tasks = ref<Record<string, Task>>({});
  const activity = ref<Activity[]>([]);
  const selectedId = ref<string | null>(null);
  const connection = ref<'connecting' | 'live' | 'offline'>('connecting');
  const lastError = ref<string | null>(null);
  /** IDs deleted in this session. A late response or event for one of them must not bring it back. */
  const deletedIds = new Set<string>();

  // ---- Derived state (never stored, always recomputed from `tasks`) ----
  const taskList = computed(() => Object.values(tasks.value).sort(byPriorityThenTitle));

  const countsByStatus = computed(() => {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    for (const task of taskList.value) counts[task.status]++;
    return counts;
  });

  const tasksByAssignee = computed(() => {
    const groups = Object.fromEntries(TEAM.map((a) => [a, [] as Task[]])) as Record<Assignee, Task[]>;
    for (const task of taskList.value) groups[task.assignee].push(task);
    return groups;
  });

  const countsByAssignee = computed(
    () => Object.fromEntries(TEAM.map((a) => [a, tasksByAssignee.value[a].length])) as Record<Assignee, number>,
  );

  /** null when nothing is selected, or when the selected task has been deleted. */
  const selectedTask = computed(() => (selectedId.value ? (tasks.value[selectedId.value] ?? null) : null));

  // ---- Applying server data ----

  /** Stores a task from the server unless we already have the same or a newer version of it. */
  function receive(task: Task): void {
    if (deletedIds.has(task.id)) return;
    const current = tasks.value[task.id];
    if (current && current.version >= task.version) return; // duplicate or out-of-order: ignore
    tasks.value[task.id] = task;
  }

  function forget(id: string): void {
    deletedIds.add(id);
    delete tasks.value[id];
  }

  function addActivity(entry: Activity): void {
    if (activity.value.some((a) => a.id === entry.id)) return;
    activity.value = [entry, ...activity.value].slice(0, MAX_ACTIVITY);
  }

  /** Entry point for everything pushed by the server (see connection.ts). */
  function applyEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'snapshot':
        // The server's full state replaces ours: anything missed while disconnected is fixed here.
        tasks.value = Object.fromEntries(event.tasks.map((t) => [t.id, t]));
        activity.value = event.activity.slice(0, MAX_ACTIVITY);
        deletedIds.clear();
        break;
      case 'task.upserted':
        receive(event.task);
        addActivity(event.activity);
        break;
      case 'task.deleted':
        forget(event.id);
        addActivity(event.activity);
        break;
    }
  }

  // ---- User actions ----

  function select(id: string | null): void {
    selectedId.value = id;
  }

  /**
   * Optimistic update: the change shows everywhere immediately, then the server's answer replaces it.
   * If the server rejects it, the previous value is restored, unless the server has sent a newer version
   * in the meantime (then that newer version is the truth).
   */
  async function updateTask(id: string, patch: TaskPatch): Promise<void> {
    const previous = tasks.value[id];
    if (!previous) return;
    tasks.value[id] = { ...previous, ...patch };
    try {
      receive(await api.updateTask(id, patch));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        forget(id);
        lastError.value = 'That task was deleted by someone else.';
        return;
      }
      if (tasks.value[id]?.version === previous.version) tasks.value[id] = previous;
      lastError.value = `Could not save the change: ${(err as Error).message}`;
    }
  }

  /** Not optimistic: the task needs its server-assigned ID before it can be shown and edited. */
  async function createTask(input: NewTask): Promise<Task | undefined> {
    try {
      const task = await api.createTask(input);
      receive(task);
      return task;
    } catch (err) {
      lastError.value = `Could not create the task: ${(err as Error).message}`;
      return undefined;
    }
  }

  /** Optimistic delete; restored if the server refuses (a 404 means it's already gone, which is fine). */
  async function deleteTask(id: string): Promise<void> {
    const previous = tasks.value[id];
    if (!previous) return;
    forget(id);
    try {
      await api.deleteTask(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return;
      deletedIds.delete(id);
      tasks.value[id] = previous;
      lastError.value = `Could not delete the task: ${(err as Error).message}`;
    }
  }

  return {
    tasks,
    activity,
    selectedId,
    connection,
    lastError,
    taskList,
    countsByStatus,
    countsByAssignee,
    tasksByAssignee,
    selectedTask,
    applyEvent,
    select,
    updateTask,
    createTask,
    deleteTask,
  };
});
