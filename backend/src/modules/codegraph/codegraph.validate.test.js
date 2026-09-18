/**
 * Unit tests for post-index validation probes.
 */
import { describe, expect, it } from 'vitest';
import { validateCodegraphIndex } from './codegraph.validate.js';

describe('codegraph.validate', () => {
  it('passes when index state is healthy and watcher is off', async () => {
    const result = await validateCodegraphIndex({
      graph: {
        getIndexState: () => 'complete',
        getStats: () => ({ fileCount: 3, nodeCount: 10 }),
        isWatching: () => false,
      },
      expectedIndexedFileCount: 3,
      expectedExcludedCount: 1,
      graphPath: '/tmp/ws/.codegraph',
      sourceVersionId: 'sv1',
      mode: 'indexAll',
      indexedFileCount: 3,
      skippedFileCount: 1,
      graphHash: 'abc',
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.hardFail).toBe(false);
    expect(result.identity).toEqual({
      graphPath: '/tmp/ws/.codegraph',
      graphHash: 'abc',
      indexedAt: '2026-01-02T00:00:00.000Z',
      sourceVersionId: 'sv1',
      indexedFileCount: 3,
      skippedFileCount: 1,
      mode: 'indexAll',
    });
    expect(result.probes.every((p) => p.passed)).toBe(true);
  });

  it('hard-fails when index state is failed', async () => {
    const result = await validateCodegraphIndex({
      graph: {
        getIndexState: () => 'failed',
        getStats: () => ({ fileCount: 0, nodeCount: 0 }),
        isWatching: () => false,
      },
      expectedIndexedFileCount: 1,
      expectedExcludedCount: 0,
      graphPath: '/tmp/ws/.codegraph',
      sourceVersionId: 'sv1',
      mode: 'indexAll',
      indexedFileCount: 0,
      skippedFileCount: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.hardFail).toBe(true);
    expect(result.probes.find((p) => p.name === 'index_state_healthy')?.passed).toBe(false);
  });

  it('fails watcher_off when the library is still watching', async () => {
    const result = await validateCodegraphIndex({
      graph: {
        getIndexState: () => 'complete',
        getStats: () => ({ fileCount: 1, nodeCount: 1 }),
        isWatching: () => true,
      },
      expectedIndexedFileCount: 1,
      expectedExcludedCount: 0,
      graphPath: '/tmp/ws/.codegraph',
      sourceVersionId: 'sv1',
      mode: 'sync',
      indexedFileCount: 1,
      skippedFileCount: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.probes.find((p) => p.name === 'watcher_off')?.passed).toBe(false);
  });

  it('fails exclusion_accounting when indexed exceeds candidates', async () => {
    const result = await validateCodegraphIndex({
      graph: {
        getIndexState: () => 'complete',
        getStats: () => ({ fileCount: 9, nodeCount: 9 }),
        isWatching: () => false,
      },
      expectedIndexedFileCount: 2,
      expectedExcludedCount: 0,
      graphPath: '/tmp/ws/.codegraph',
      sourceVersionId: 'sv1',
      mode: 'indexAll',
      indexedFileCount: 9,
      skippedFileCount: 0,
    });

    expect(result.probes.find((p) => p.name === 'exclusion_accounting')?.passed).toBe(false);
  });

  it('fails when graphPath is missing', async () => {
    const result = await validateCodegraphIndex({
      graph: {
        getIndexState: () => 'complete',
        getStats: () => ({ fileCount: 1, nodeCount: 1 }),
        isWatching: () => false,
      },
      expectedIndexedFileCount: 1,
      expectedExcludedCount: 0,
      graphPath: '',
      sourceVersionId: 'sv1',
      mode: 'indexAll',
      indexedFileCount: 1,
      skippedFileCount: 0,
    });
    expect(result.probes.find((p) => p.name === 'index_dir_present')?.passed).toBe(false);
  });

  it('fails partial index without exclusions or skips', async () => {
    const result = await validateCodegraphIndex({
      graph: {
        getIndexState: () => 'partial',
        getStats: () => ({ fileCount: 1, nodeCount: 1 }),
        isWatching: () => false,
      },
      expectedIndexedFileCount: 1,
      expectedExcludedCount: 0,
      graphPath: '/tmp/ws/.codegraph',
      sourceVersionId: 'sv1',
      mode: 'indexAll',
      indexedFileCount: 1,
      skippedFileCount: 0,
    });
    expect(result.probes.find((p) => p.name === 'index_state_healthy')?.passed).toBe(false);
  });

  it('fails when getStats lacks fileCount', async () => {
    const result = await validateCodegraphIndex({
      graph: {
        getIndexState: () => 'complete',
        getStats: () => ({}),
        isWatching: () => false,
      },
      expectedIndexedFileCount: 1,
      expectedExcludedCount: 0,
      graphPath: '/tmp/ws/.codegraph',
      sourceVersionId: 'sv1',
      mode: 'indexAll',
      indexedFileCount: 1,
      skippedFileCount: 0,
    });
    expect(result.probes.find((p) => p.name === 'stats_readable')?.passed).toBe(false);
  });
});
