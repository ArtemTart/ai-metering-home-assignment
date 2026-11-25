// Types shared by the mock server and the Vue client, so both sides agree on the wire format.

export const STATUSES = ['todo', 'in_progress', 'done'] as const;
export const PRIORITIES = ['low', 'medium', 'high'] as const;
export const TEAM = ['Alice', 'Bob', 'Carol', 'Dan'] as const;

export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Assignee = (typeof TEAM)[number];

export interface Task {
  id: string;
  title: string;
  assignee: Assignee;
  status: Status;
  priority: Priority;
  /** Incremented by the server on every change; the client ignores anything older than what it has. */
  version: number;
  updatedAt: string;
}

/** Fields a user can change. */
export type TaskPatch = Partial<Pick<Task, 'title' | 'assignee' | 'status' | 'priority'>>;
export type NewTask = Pick<Task, 'title' | 'assignee' | 'status' | 'priority'>;

export interface Activity {
  id: number;
  at: string;
  /** Who made the change: a user through the UI, or the simulated "other side". */
  actor: 'user' | 'server';
  message: string;
}

/** Everything the server pushes over Server-Sent Events. */
export type ServerEvent =
  /** Sent first on every (re)connect: the full truth, replacing whatever the client had. */
  | { type: 'snapshot'; tasks: Task[]; activity: Activity[] }
  | { type: 'task.upserted'; task: Task; activity: Activity }
  | { type: 'task.deleted'; id: string; activity: Activity };
