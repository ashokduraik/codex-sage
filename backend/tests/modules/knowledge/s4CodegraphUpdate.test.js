/**
 * Unit tests for S4 codegraph_update.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSourceFilesOrdered = vi.fn();
const codegraphIndexExists = vi.fn();
const resolveProjectWorkspacePath = vi.fn();
const loadConfig = vi.fn();

vi.mock('../../../src/modules/knowledge/ingest.js', async () => {
  const actual = await vi.importActual('../../../src/modules/knowledge/ingest.js');
  return {
    ...actual,
    listSourceFilesOrdered: (...args) => listSourceFilesOrdered(...args),
  };
});

vi.mock('../../../src/modules/knowledge/codegraph.js', async () => {
  const actual = await vi.importActual('../../../src/modules/knowledge/codegraph.js');
  return {
    ...actual,
    codegraphIndexExists: (...args) => codegraphIndexExists(...args),
  };
});

vi.mock('../../../src/modules/knowledge/sources.js', async () => {
  const actual = await vi.importActual('../../../src/modules/knowledge/sources.js');
  return {
    ...actual,
    resolveProjectWorkspacePath: (...args) => resolveProjectWorkspacePath(...args),
  };
});

vi.mock('../../../src/platform/config.js', () => ({
  loadConfig: (...args) => loadConfig(...args),
}));

const { runCodegraphUpdateStage } = await import('../../../src/modules/knowledge/ingest.util.js');

describe('runCodegraphUpdateStage', () => {
  /** @type {ReturnType<typeof createMockAdapter>} */
  let adapter;

  beforeEach(() => {
    listSourceFilesOrdered.mockReset();
    codegraphIndexExists.mockReset().mockResolvedValue(false);
    resolveProjectWorkspacePath.mockReset().mockReturnValue('/ws/org/proj');
    loadConfig.mockReset().mockReturnValue({ workspace: { root: '/ws' } });
    adapter = createMockAdapter();
  });

  /**
   * @returns {object}
   */
  function createMockAdapter() {
    const graph = {
      close: vi.fn(),
      unwatch: vi.fn(),
      isWatching: vi.fn(() => false),
    };
    return {
      configureTelemetryOff: vi.fn(),
      disableFilesystemWatch: vi.fn(),
      acquireWriter: vi.fn(async () => vi.fn()),
      releaseWriter: vi.fn((release) => release?.()),
      indexAll: vi.fn(async () => ({
        mode: 'indexAll',
        success: true,
        indexedFileCount: 2,
        skippedFileCount: 0,
        filesErrored: 0,
        graphPath: '/ws/org/proj/.codegraph',
        graphHash: 'hash',
        graph,
      })),
      sync: vi.fn(async () => ({
        mode: 'sync',
        success: true,
        indexedFileCount: 1,
        skippedFileCount: 0,
        filesErrored: 0,
        graphPath: '/ws/org/proj/.codegraph',
        graphHash: 'hash2',
        graph,
      })),
      validate: vi.fn(async () => ({
        ok: true,
        hardFail: false,
        identity: {
          graphPath: '/ws/org/proj/.codegraph',
          graphHash: 'hash',
          indexedAt: '2026-01-01T00:00:00.000Z',
          sourceVersionId: 'v1',
          indexedFileCount: 2,
          skippedFileCount: 1,
          mode: 'indexAll',
        },
        coverage: {
          indexedFiles: 2,
          skippedFiles: 1,
          expectedIndexed: 2,
          expectedExcluded: 1,
        },
        probes: [{ name: 'index_dir_present', passed: true }],
      })),
    };
  }

  /**
   * @returns {object}
   */
  function buildCtx() {
    return {
      scope: { orgId: 'o', projectId: 'p', sourceVersionId: 'v1' },
      carry: {},
      signal: { aborted: false },
      isCancelRequested: vi.fn().mockResolvedValue(false),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      saveProgress: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('indexes when no .codegraph exists and skips excludedFromGraph paths', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
      { path: 'big.js', fileState: 'stored', excludedFromGraph: true },
      { path: 'missing.js', fileState: 'missing', excludedFromGraph: false },
    ]);
    const ctx = buildCtx();
    const result = await runCodegraphUpdateStage(ctx, { adapter });

    expect(adapter.configureTelemetryOff).toHaveBeenCalled();
    expect(adapter.indexAll).toHaveBeenCalledWith(
      '/ws/org/proj',
      expect.objectContaining({
        excludedPaths: ['big.js'],
      }),
    );
    expect(adapter.sync).not.toHaveBeenCalled();
    expect(result.cursor.graphIdentity.sourceVersionId).toBe('v1');
    expect(ctx.carry.graphIdentity).toEqual(result.cursor.graphIdentity);
    expect(ctx.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'structure.analyzed' }),
    );
    expect(ctx.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'relationships.analyzed' }),
    );
    expect(adapter.releaseWriter).toHaveBeenCalled();
  });

  it('syncs when an index already exists', async () => {
    codegraphIndexExists.mockResolvedValue(true);
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    const ctx = buildCtx();
    ctx.carry.changedPaths = ['a.js'];
    await runCodegraphUpdateStage(ctx, { adapter });
    expect(adapter.sync).toHaveBeenCalledWith(
      '/ws/org/proj',
      expect.objectContaining({ changedPaths: ['a.js'] }),
    );
  });

  it('fails permanent when workspace path resolution is unsafe', async () => {
    resolveProjectWorkspacePath.mockImplementation(() => {
      throw Object.assign(new Error('unsafe'), { code: 'WORKSPACE_PATH_UNSAFE' });
    });
    listSourceFilesOrdered.mockResolvedValue([]);
    await expect(runCodegraphUpdateStage(buildCtx(), { adapter })).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_UNSAFE',
      failureClass: 'permanent',
    });
  });

  it('maps validation failure to CODEGRAPH_VALIDATION_FAILED', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    adapter.validate.mockResolvedValue({
      ok: false,
      hardFail: true,
      identity: {},
      probes: [{ name: 'index_state_healthy', passed: false }],
    });
    await expect(runCodegraphUpdateStage(buildCtx(), { adapter })).rejects.toMatchObject({
      code: 'CODEGRAPH_VALIDATION_FAILED',
      failureClass: 'temporary',
    });
    expect(adapter.releaseWriter).toHaveBeenCalled();
  });

  it('maps library throw to CODEGRAPH_LIBRARY_ERROR when unclassified', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    adapter.indexAll.mockRejectedValue(new Error('boom'));
    await expect(runCodegraphUpdateStage(buildCtx(), { adapter })).rejects.toMatchObject({
      code: 'CODEGRAPH_LIBRARY_ERROR',
      failureClass: 'temporary',
    });
  });

  it('maps classified adapter failures through to the job error', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    adapter.indexAll.mockRejectedValue(
      Object.assign(new Error('locked'), {
        failureClass: 'temporary',
        code: 'CODEGRAPH_SQLITE_BUSY',
      }),
    );
    await expect(runCodegraphUpdateStage(buildCtx(), { adapter })).rejects.toMatchObject({
      code: 'CODEGRAPH_SQLITE_BUSY',
      failureClass: 'temporary',
    });
  });

  it('records warnings when the indexer reports file errors', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    adapter.indexAll.mockResolvedValue({
      mode: 'indexAll',
      success: true,
      indexedFileCount: 1,
      skippedFileCount: 0,
      filesErrored: 2,
      graphPath: '/ws/org/proj/.codegraph',
      graphHash: 'hash',
      graph: { close: vi.fn(), unwatch: vi.fn(), isWatching: vi.fn(() => false) },
    });
    const result = await runCodegraphUpdateStage(buildCtx(), { adapter });
    expect(result.outcome).toBe('completed_with_warnings');
    expect(result.warnings[0].code).toBe('CODEGRAPH_FILE_ERRORS');
  });

  it('maps validate throw to CODEGRAPH_VALIDATION_FAILED', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    adapter.validate.mockRejectedValue(new Error('probe crash'));
    await expect(runCodegraphUpdateStage(buildCtx(), { adapter })).rejects.toMatchObject({
      code: 'CODEGRAPH_VALIDATION_FAILED',
    });
  });

  it('omits changedPaths from sync when removedPaths are present', async () => {
    codegraphIndexExists.mockResolvedValue(true);
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    const ctx = buildCtx();
    ctx.carry.changedPaths = ['a.js'];
    ctx.carry.removedPaths = ['gone.js'];
    await runCodegraphUpdateStage(ctx, { adapter });
    expect(adapter.sync).toHaveBeenCalledWith(
      '/ws/org/proj',
      expect.objectContaining({ changedPaths: undefined }),
    );
  });

  it('accepts changedPaths as a Set on carry', async () => {
    codegraphIndexExists.mockResolvedValue(true);
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    const ctx = buildCtx();
    ctx.carry.changedPaths = new Set(['a.js']);
    await runCodegraphUpdateStage(ctx, { adapter });
    expect(adapter.sync).toHaveBeenCalledWith(
      '/ws/org/proj',
      expect.objectContaining({ changedPaths: ['a.js'] }),
    );
  });

  it('aborts after acquiring the writer when cancel flips mid-stage', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    const ctx = buildCtx();
    let calls = 0;
    ctx.isCancelRequested = vi.fn(async () => {
      calls += 1;
      return calls > 1;
    });
    await expect(runCodegraphUpdateStage(ctx, { adapter })).rejects.toMatchObject({
      code: 'INGEST_ABORTED',
    });
    expect(adapter.releaseWriter).toHaveBeenCalled();
  });

  it('uses carry.workspaceRoot when provided', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      { path: 'a.js', fileState: 'stored', excludedFromGraph: false },
    ]);
    const ctx = buildCtx();
    ctx.carry.workspaceRoot = '/custom-root';
    await runCodegraphUpdateStage(ctx, { adapter });
    expect(resolveProjectWorkspacePath).toHaveBeenCalledWith('/custom-root', 'o', 'p');
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
