import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // The browser talks to one origin; Vite forwards /api (REST and the SSE stream) to the mock server.
    proxy: { '/api': 'http://localhost:3001' },
  },
  test: {
    environment: 'happy-dom',
  },
});
