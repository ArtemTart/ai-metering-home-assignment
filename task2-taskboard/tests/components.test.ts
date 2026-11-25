import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import type { Task } from '../shared/types.js';
import { api } from '../src/api.js';
import AssigneeView from '../src/components/AssigneeView.vue';
import SummaryPanel from '../src/components/SummaryPanel.vue';
import TaskEditor from '../src/components/TaskEditor.vue';
import TaskList from '../src/components/TaskList.vue';
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
const activity = { id: 1, at: '2026-01-01T00:00:00.000Z', actor: 'server' as const, message: 'x' };

/** All panels mounted together on one store, as in the real app (minus the SSE connection). */
function mountBoard(tasks: Task[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useBoardStore();
  store.applyEvent({ type: 'snapshot', tasks, activity: [] });
  const wrapper = mount({ render: () => [h(TaskList), h(TaskEditor), h(SummaryPanel), h(AssigneeView)] }, { global: { plugins: [pinia] } });
  return { store, wrapper };
}

beforeEach(() => vi.restoreAllMocks());

describe('components share one state', () => {
  // Requirement 1: change the status in the list, and the summary, the assignee view and the editor all
  // show it right away (before the server has even answered).
  it('a status change in the list updates every other panel', async () => {
    vi.spyOn(api, 'updateTask').mockImplementation(async (id, patch) => task(id, { ...patch, version: 2 }));
    const { store, wrapper } = mountBoard([task('a'), task('b', { assignee: 'Bob' })]);
    store.select('a');
    await flushPromises();

    await wrapper.get('[data-testid="row-a"] select[aria-label="Status"]').setValue('done');

    expect(wrapper.get('[data-testid="status-done"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="status-todo"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="group-Alice"]').text()).toContain('Done');
    expect((wrapper.findAll('.editor select')[1]!.element as HTMLSelectElement).value).toBe('done');
  });

  // Changing the assignee in the editor moves the task between groups and updates the per-person counts.
  it('an assignee change in the editor updates the list, summary and groups', async () => {
    vi.spyOn(api, 'updateTask').mockImplementation(async (id, patch) => task(id, { ...patch, version: 2 }));
    const { store, wrapper } = mountBoard([task('a')]);
    store.select('a');
    await flushPromises();

    await wrapper.findAll('.editor select')[0]!.setValue('Dan');
    await wrapper.get('.editor').trigger('submit');
    await flushPromises();

    expect(api.updateTask).toHaveBeenCalledWith('a', { assignee: 'Dan' }); // only the changed field is sent
    expect(wrapper.get('[data-testid="assignee-Dan"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="assignee-Alice"]').text()).toBe('0');
    expect(wrapper.get('[data-testid="group-Dan"]').text()).toContain('Task a');
    expect((wrapper.get('[data-testid="row-a"] select[aria-label="Assignee"]').element as HTMLSelectElement).value).toBe('Dan');
  });

  // Requirement 3: a change pushed by the server reaches every panel too.
  it('a server push updates every panel', async () => {
    const { store, wrapper } = mountBoard([task('a')]);
    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 2, status: 'in_progress', assignee: 'Carol' }), activity });
    await flushPromises();

    expect(wrapper.get('[data-testid="status-in_progress"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="group-Carol"]').text()).toContain('Task a');
    expect((wrapper.get('[data-testid="row-a"] select[aria-label="Status"]').element as HTMLSelectElement).value).toBe('in_progress');
  });
});

describe('editor edge cases', () => {
  // The server changes the task while the user has unsaved edits: the draft is kept and a notice is shown.
  it("keeps the user's draft and warns when the task changes remotely", async () => {
    const { store, wrapper } = mountBoard([task('a')]);
    store.select('a');
    await flushPromises();
    await wrapper.get('.editor input').setValue('My new title');

    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 2, priority: 'high' }), activity });
    await flushPromises();

    expect(wrapper.text()).toContain('Someone else changed this task');
    expect((wrapper.get('.editor input').element as HTMLInputElement).value).toBe('My new title');
  });

  // Without unsaved edits, the editor simply shows the new values.
  it('refreshes silently when there are no unsaved edits', async () => {
    const { store, wrapper } = mountBoard([task('a')]);
    store.select('a');
    await flushPromises();

    store.applyEvent({ type: 'task.upserted', task: task('a', { version: 2, title: 'Renamed' }), activity });
    await flushPromises();

    expect(wrapper.text()).not.toContain('Someone else changed');
    expect((wrapper.get('.editor input').element as HTMLInputElement).value).toBe('Renamed');
  });

  // The task open in the editor is deleted by the server.
  it('shows that the selected task was deleted', async () => {
    const { store, wrapper } = mountBoard([task('a')]);
    store.select('a');
    store.applyEvent({ type: 'task.deleted', id: 'a', activity });
    await flushPromises();
    expect(wrapper.text()).toContain('This task was deleted');
  });

  // An empty or whitespace-only title can't be saved.
  it('does not save a blank title', async () => {
    const spy = vi.spyOn(api, 'updateTask');
    const { store, wrapper } = mountBoard([task('a')]);
    store.select('a');
    await flushPromises();
    await wrapper.get('.editor input').setValue('   ');
    await wrapper.get('.editor').trigger('submit');
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Title is required');
  });
});
