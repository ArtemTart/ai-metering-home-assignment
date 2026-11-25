import type { NewTask, Task, TaskPatch } from '../shared/types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, error?.message ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** REST calls to the mock server. The store doesn't depend on fetch directly, so tests can replace this. */
export const api = {
  createTask: (task: NewTask) => request<Task>('POST', '/api/tasks', task),
  updateTask: (id: string, patch: TaskPatch) => request<Task>('PATCH', `/api/tasks/${id}`, patch),
  deleteTask: (id: string) => request<void>('DELETE', `/api/tasks/${id}`),
};
