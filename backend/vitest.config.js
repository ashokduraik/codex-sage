import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    // Shared external Mongo test DB — parallel files would race on deleteMany.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // Process entrypoints that bind listen / signal handlers at import time.
      exclude: [
        'src/index.js',
        'src/worker/index.js',
        'src/**/*.test.js',
        'src/test/fixtures/**',
      ],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
      reporter: ['text', 'lcov'],
    },
  },
});
