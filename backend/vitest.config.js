import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Shared external Mongo test DB — parallel files would race on deleteMany.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // API process entry binds listen / signal handlers at import time.
      // Worker entry uses a main-module guard so startWorker is importable and covered.
      exclude: ['src/index.js'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
      reporter: ['text', 'lcov'],
    },
  },
});
