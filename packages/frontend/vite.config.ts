import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forward API calls to the Fastify server so the browser talks to a
      // single origin in dev; HttpDataSource (Phase E) uses relative /api paths.
      '/api': 'http://localhost:5174',
    },
  },
});
