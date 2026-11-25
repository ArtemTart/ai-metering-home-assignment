import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // The browser talks to one origin; Vite forwards /api (REST and the SSE stream) to the mock server.
    // Same PORT as the mock server (.env). Override with PORT=… when 3001 is already taken.
    proxy: { '/api': `http://localhost:${process.env.PORT || 3001}` },
  },
  test: {
    environment: 'happy-dom',
  },
});
