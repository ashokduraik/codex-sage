import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/worker/index.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  sourcemap: true,
});
