import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // Dev: forward /api/* to the Node API (paths include the /api prefix).
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    globals: false,
    // jsdom + React + parallel workers can exceed the 5s default on cold imports.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    teardownTimeout: 15_000,
    setupFiles: ['src/test/setup.js'],
    // Pin VITE_ env vars so tests are independent of the developer's local .env file.
    env: {
      VITE_API_BASE_URL: '/api/v1',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      exclude: [
        'src/main.jsx',
        'src/**/*.test.{js,jsx}',
        'src/test/**',
        'src/shared/ui/**',
      ],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
      reporter: ['text', 'lcov'],
    },
  },
});
