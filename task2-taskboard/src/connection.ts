import type { ServerEvent } from '../shared/types.js';
import type { useBoardStore } from './stores/board.js';

/**
 * Connects the store to the server's Server-Sent Events stream. EventSource reconnects by itself after a
 * network error; the server then sends a fresh snapshot, so nothing missed while offline stays stale.
 * Returns a function that closes the connection.
 */
export function connectToServer(store: ReturnType<typeof useBoardStore>, url = '/api/events'): () => void {
  const source = new EventSource(url);
  store.connection = 'connecting';
  source.onopen = () => (store.connection = 'live');
  source.onerror = () => (store.connection = 'offline');
  source.onmessage = (message: MessageEvent<string>) => {
    store.applyEvent(JSON.parse(message.data) as ServerEvent);
  };
  return () => source.close();
}
