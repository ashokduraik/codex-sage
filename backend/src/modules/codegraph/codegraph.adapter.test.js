/**
 * Unit tests for the CodeGraph adapter (mocked library).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodegraphAdapter, mapCodegraphLibraryError } from './codegraph.adapter.js';
import { resetCodegraphTelemetryConfiguredFlag } from './codegraph.telemetry.js';
import { resetWriterLocksForTests } from './codegraph.writerLock.js';

describe('codegraph.adapter', () => {
  /** @type {string[]} */
  const tempDirs = [];
  /** @type {ReturnType<typeof createMockLibrary>} */
  let mockLib;

  afterEach(async () => {
    resetWriterLocksForTests();
    resetCodegraphTelemetryConfiguredFlag();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  beforeEach(() => {
    mockLib = createMockLibrary();
  });

  /**
   * @returns {Promise<string>}
   */
  async function makeTempWorkspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-adapter-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'hello.js'), 'export const x = 1;\n', 'utf8');
    return dir;
  }

  /**
   * @returns {{
   *   CodeGraph: object,
   *   getDatabasePath: (root: string) => string,
   *   instances: object[],
   * }}
   */
  function createMockLibrary() {
    const instances = [];
    const CodeGraph = {
      isInitialized: vi.fn(() => false),
      init: vi.fn(async (root) => {
        const graph = createMockGraph(root);
        instances.push(graph);
        await fs.mkdir(path.join(root, '.codegraph'), { recursive: true });
        return graph;
      }),
      open: vi.fn(async (root) => {
        const graph = createMockGraph(root);
        instances.push(graph);
        return graph;
      }),
      recreate: vi.fn(async (root) => {
        await fs.rm(path.join(root, '.codegraph'), { recursive: true, force: true });
        await fs.mkdir(path.join(root, '.codegraph'), { recursive: true });
        const graph = createMockGraph(root);
        instances.push(graph);
        return graph;
      }),
    };
    return {
      CodeGraph,
      getDatabasePath: (root) => path.join(root, '.codegraph', 'codegraph.db'),
      instances,
    };
  }

  /**
   * @param {string} root
   * @returns {object}
   */
  function createMockGraph(root) {
    return {
      root,
      watching: false,
      unwatch: vi.fn(function unwatch() {
        this.watching = false;
      }),
      isWatching: vi.fn(function isWatching() {
        return this.watching;
      }),
      indexAll: vi.fn(async () => {
        await fs.writeFile(
          path.join(root, '.codegraph', 'codegraph.db'),
          'mock-db',
          'utf8',
        );
        return {
          success: true,
          filesIndexed: 2,
          filesSkipped: 0,
          filesErrored: 0,
          nodesCreated: 4,
          edgesCreated: 1,
          errors: [],
          durationMs: 1,
        };
      }),
      sync: vi.fn(async () => ({
        filesChecked: 2,
        filesAdded: 0,
        filesModified: 1,
        filesRemoved: 0,
        nodesUpdated: 1,
        durationMs: 1,
      })),
      getIndexState: vi.fn(() => 'complete'),
      getStats: vi.fn(() => ({ fileCount: 2, nodeCount: 4, dbSizeBytes: 10, lastUpdated: 1 })),
      close: vi.fn(),
    };
  }

  it('configures telemetry before loading the library', async () => {
    let sawTelemetry = false;
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => {
        sawTelemetry = process.env.CODEGRAPH_TELEMETRY === '0';
        return mockLib;
      },
    });
    const workspace = await makeTempWorkspace();
    await adapter.indexAll(workspace, { excludedPaths: ['skip.js'] });
    expect(sawTelemetry).toBe(true);
  });

  it('writes exclude config and never enables the filesystem watcher', async () => {
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    const workspace = await makeTempWorkspace();
    const result = await adapter.indexAll(workspace, { excludedPaths: ['big.js'] });
    const config = JSON.parse(
      await fs.readFile(path.join(workspace, 'codegraph.json'), 'utf8'),
    );
    expect(config.exclude).toEqual(['big.js']);
    expect(result.graph.isWatching()).toBe(false);
    expect(result.mode).toBe('indexAll');
    expect(result.indexedFileCount).toBe(2);
  });

  it('uses sync when an index already exists and passes changedPaths', async () => {
    mockLib.CodeGraph.isInitialized.mockReturnValue(true);
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    const workspace = await makeTempWorkspace();
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    const result = await adapter.sync(workspace, {
      excludedPaths: [],
      changedPaths: ['hello.js'],
    });
    expect(result.mode).toBe('sync');
    expect(mockLib.instances[0].sync).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ['hello.js'] }),
    );
  });

  it('maps SQLITE busy errors to temporary CODEGRAPH_SQLITE_BUSY', () => {
    expect(
      mapCodegraphLibraryError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })),
    ).toMatchObject({
      failureClass: 'temporary',
      code: 'CODEGRAPH_SQLITE_BUSY',
    });
  });

  it('retries transient library failures then succeeds', async () => {
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
      maxRetryAttempts: 3,
    });
    const workspace = await makeTempWorkspace();
    let calls = 0;

    const attachFlakyIndex = (graph, root) => {
      graph.indexAll = vi.fn(async () => {
        calls += 1;
        if (calls < 2) {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        }
        await fs.writeFile(path.join(root, '.codegraph', 'codegraph.db'), 'ok', 'utf8');
        return {
          success: true,
          filesIndexed: 1,
          filesSkipped: 0,
          filesErrored: 0,
        };
      });
      return graph;
    };

    mockLib.CodeGraph.init.mockImplementation(async (root) => {
      await fs.mkdir(path.join(root, '.codegraph'), { recursive: true });
      return attachFlakyIndex(createMockGraph(root), root);
    });
    mockLib.CodeGraph.recreate.mockImplementation(async (root) => {
      await fs.mkdir(path.join(root, '.codegraph'), { recursive: true });
      return attachFlakyIndex(createMockGraph(root), root);
    });

    const result = await adapter.indexAll(workspace, {});
    expect(result.indexedFileCount).toBe(1);
    expect(calls).toBe(2);
  });

  it('explore and buildContext throw NOT_IMPLEMENTED', async () => {
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    await expect(adapter.explore()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(adapter.buildContext()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('validate hard-fails when the mock index state is failed', async () => {
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    const workspace = await makeTempWorkspace();
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    mockLib.CodeGraph.isInitialized.mockReturnValue(true);
    mockLib.CodeGraph.open.mockImplementation(async (root) => {
      const graph = createMockGraph(root);
      graph.getIndexState = () => 'failed';
      mockLib.instances.push(graph);
      return graph;
    });
    const validation = await adapter.validate(workspace, {
      sourceVersionId: 'sv',
      mode: 'indexAll',
      indexedFileCount: 0,
      skippedFileCount: 0,
      expectedIndexedFileCount: 1,
      expectedExcludedCount: 0,
      graphPath: path.join(workspace, '.codegraph'),
    });
    expect(validation.hardFail).toBe(true);
  });

  it('maps ENOENT library errors to CODEGRAPH_IO_ERROR', () => {
    expect(
      mapCodegraphLibraryError(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    ).toMatchObject({
      failureClass: 'temporary',
      code: 'CODEGRAPH_IO_ERROR',
    });
  });

  it('maps non-Error throws to CODEGRAPH_LIBRARY_ERROR', () => {
    expect(mapCodegraphLibraryError('plain-string')).toMatchObject({
      code: 'CODEGRAPH_LIBRARY_ERROR',
    });
  });

  it('throws when disableFilesystemWatch cannot stop the watcher', async () => {
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    expect(() =>
      adapter.disableFilesystemWatch({
        unwatch() {},
        isWatching: () => true,
      }),
    ).toThrow(/watcher could not be disabled/);
  });

  it('aborts indexAll when the signal is already aborted', async () => {
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    const workspace = await makeTempWorkspace();
    const signal = { aborted: true };
    await expect(adapter.indexAll(workspace, { signal })).rejects.toMatchObject({
      code: 'INGEST_ABORTED',
    });
  });

  it('aborts sync when the signal is already aborted', async () => {
    mockLib.CodeGraph.isInitialized.mockReturnValue(true);
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    const workspace = await makeTempWorkspace();
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    await expect(adapter.sync(workspace, { signal: { aborted: true } })).rejects.toMatchObject({
      code: 'INGEST_ABORTED',
    });
  });

  it('force-recreates when indexAll runs against an existing index dir', async () => {
    const adapter = createCodegraphAdapter({
      loadLibrary: async () => mockLib,
    });
    const workspace = await makeTempWorkspace();
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    await adapter.indexAll(workspace, {});
    expect(mockLib.CodeGraph.recreate).toHaveBeenCalled();
  });

  it('isCodegraphLoadable returns true when the package imports', async () => {
    const { isCodegraphLoadable } = await import('./codegraph.adapter.js');
    await expect(isCodegraphLoadable()).resolves.toBe(true);
  });
});
