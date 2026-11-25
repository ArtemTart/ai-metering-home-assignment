import type { Priority, Status } from '../shared/types.js';

export const STATUS_LABELS: Record<Status, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
export const PRIORITY_LABELS: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High' };
