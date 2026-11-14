import { defineConfig } from 'vitest/config';

// In development /api/* is served by the local API runner (python api/dev_server.py).
// In production Amplify rewrites /api/* to the Lambda Function URLs.
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
