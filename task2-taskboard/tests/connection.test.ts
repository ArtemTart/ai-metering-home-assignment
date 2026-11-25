import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectToServer } from '../src/connection.js';
import { useBoardStore } from '../src/stores/board.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
}

describe('connectToServer', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  // A malformed SSE frame must not break the listener — later good frames still apply.
  it('ignores a bad JSON frame and keeps applying good ones', () => {
    const store = useBoardStore();
    connectToServer(store);
    const source = FakeEventSource.instances[0]!;

    source.onmessage?.({ data: 'not-json{' } as MessageEvent<string>);
    expect(Object.keys(store.tasks)).toHaveLength(0);

    source.onmessage?.({
      data: JSON.stringify({
        type: 'snapshot',
        tasks: [{ id: 'a', title: 'Ok', assignee: 'Alice', status: 'todo', priority: 'low', version: 1, updatedAt: 't' }],
        activity: [],
      }),
    } as MessageEvent<string>);
    expect(store.tasks.a?.title).toBe('Ok');
  });
});
