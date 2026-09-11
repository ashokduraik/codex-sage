import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entrypoints that bind listen / signal handlers at import time.
      exclude: ['src/index.ts', 'src/worker/index.ts', 'src/**/*.test.ts'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
      reporter: ['text', 'lcov'],
    },
  },
});
