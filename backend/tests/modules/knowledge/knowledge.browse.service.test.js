/**
 * Unit tests for knowledge browse orchestration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KNOWLEDGE_VERSION_ID = '6650f1a2c3d4e5f601020304';
const SOURCE_VERSION_ID = '6650f1a2c3d4e5f601020305';

const { findProjectById, hasActiveProjectWriterLock, listSectionsForVersion, createCodegraphAdapter, knowledgeVersionFindOne } = vi.hoisted(() => ({
  findProjectById: vi.fn(),
  hasActiveProjectWriterLock: vi.fn(),
  listSectionsForVersion: vi.fn(),
  createCodegraphAdapter: vi.fn(),
  knowledgeVersionFindOne: vi.fn(),
}));

vi.mock('../../../src/modules/masters/index.js', () => ({
  findProjectById,
}));

vi.mock('../../../src/worker/projectJobLock.js', () => ({
  hasActiveProjectWriterLock,
}));

vi.mock('../../../src/modules/knowledge/documents.js', () => ({
  listSectionsForVersion,
}));

vi.mock('../../../src/modules/knowledge/codegraph.js', () => ({
  resolveCodegraphDir: (workspacePath) => `${workspacePath}/.codegraph`,
  createCodegraphAdapter,
}));

vi.mock('../../../src/models/knowledgeVersion.model.js', () => ({
  KnowledgeVersion: {
    findOne: (...args) => knowledgeVersionFindOne(...args),
  },
}));

import { clampBrowseLimit, loadKnowledgeBrowse } from '../../../src/modules/knowledge/knowledge.js';

/**
 * Active ready project used by most browse paths.
 * @returns {object}
 */
function readyProject() {
  return {
    status: 'A',
    name: 'Atlas',
    knowledgeHealth: 'ready',
    lifecycleStatus: 'knowledge_ready',
    currentKnowledgeVersionId: KNOWLEDGE_VERSION_ID,
  };
}

/**
 * Stubs KnowledgeVersion.findOne().lean().exec() for the ready browse path.
 * @param {object | null} doc Lean version document.
 * @returns {void}
 */
function mockKnowledgeVersion(doc) {
  knowledgeVersionFindOne.mockReturnValue({
    lean: () => ({
      exec: () => Promise.resolve(doc),
    }),
  });
}

describe('loadKnowledgeBrowse', () => {
  beforeEach(() => {
    findProjectById.mockReset();
    hasActiveProjectWriterLock.mockReset().mockResolvedValue(false);
    listSectionsForVersion.mockReset().mockResolvedValue([]);
    createCodegraphAdapter.mockReset();
    knowledgeVersionFindOne.mockReset();
  });

  it('clamps browse page size', () => {
    expect(clampBrowseLimit(undefined)).toBe(50);
    expect(clampBrowseLimit(0)).toBe(50);
    expect(clampBrowseLimit(1000)).toBe(100);
    expect(clampBrowseLimit(12)).toBe(12);
  });

  it('throws PROJECT_NOT_FOUND for a missing or soft-deleted project', async () => {
    findProjectById.mockResolvedValue(null);
    await expect(loadKnowledgeBrowse({ orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });

    findProjectById.mockResolvedValue({ status: 'D' });
    await expect(loadKnowledgeBrowse({ orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });

  it('returns updating without acquiring a graph when the gate queues', async () => {
    findProjectById.mockResolvedValue({
      ...readyProject(),
      knowledgeHealth: 'updating',
      lifecycleStatus: 'updating',
    });
    const result = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'summary',
      workspaceRoot: '/tmp/ws',
    });
    expect(result.state).toBe('updating');
    expect(result.items).toEqual([]);
    expect(createCodegraphAdapter).not.toHaveBeenCalled();
  });

  it('returns unavailable when the gate denies', async () => {
    findProjectById.mockResolvedValue({
      ...readyProject(),
      knowledgeHealth: 'failed',
      currentKnowledgeVersionId: null,
    });
    const result = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'symbols',
      workspaceRoot: '/tmp/ws',
    });
    expect(result.state).toBe('unavailable');
    expect(result.items).toEqual([]);
  });

  it('returns ready summary and matching version id from docs when the graph is missing', async () => {
    findProjectById.mockResolvedValue(readyProject());
    mockKnowledgeVersion({
      sourceVersionId: SOURCE_VERSION_ID,
      publishedHealth: 'ready',
      excludedFileCount: 0,
    });
    listSectionsForVersion.mockResolvedValue([{ heading: 'Intro', text: 'Payments service.' }]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
    });

    const result = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'summary',
      workspaceRoot: '/tmp/ws',
    });
    expect(result.state).toBe('ready');
    expect(result.knowledgeVersionId).toBe(KNOWLEDGE_VERSION_ID);
    expect(result.summary).toContain('Payments service.');

    const indexOnly = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'index',
      workspaceRoot: '/tmp/ws',
    });
    expect(indexOnly.facets.some((facet) => facet.key === 'documentation')).toBe(true);

    mockKnowledgeVersion({ excludedFileCount: 0 });
    listSectionsForVersion.mockResolvedValue([]);
    const emptyGraphLists = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'apis',
      workspaceRoot: '/tmp/ws',
    });
    expect(emptyGraphLists.items).toEqual([]);
  });

  it('returns updating when the lease sees a writer', async () => {
    findProjectById.mockResolvedValue(readyProject());
    mockKnowledgeVersion({ sourceVersionId: SOURCE_VERSION_ID, excludedFileCount: 0 });
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({ ok: false, reason: 'writer' }),
    });
    const result = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'symbols',
      workspaceRoot: '/tmp/ws',
    });
    expect(result.state).toBe('updating');
    expect(result.items).toEqual([]);
  });

  it('returns unavailable when the lease expires mid-query', async () => {
    findProjectById.mockResolvedValue(readyProject());
    mockKnowledgeVersion({ sourceVersionId: SOURCE_VERSION_ID, excludedFileCount: 0 });
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: { graph: {}, expired: true, release: () => {} },
      }),
    });
    const result = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'summary',
      workspaceRoot: '/tmp/ws',
    });
    expect(result.state).toBe('unavailable');
  });

  it('returns ready graph payloads and omits empty facets', async () => {
    const release = vi.fn();
    findProjectById.mockResolvedValue(readyProject());
    mockKnowledgeVersion({
      sourceVersionId: SOURCE_VERSION_ID,
      publishedHealth: 'partially_available',
      excludedFileCount: 3,
    });
    listSectionsForVersion.mockResolvedValue([{ heading: 'Docs', text: 'Hello' }]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: { graph: {}, expired: false, release },
      }),
      queryStats: () => ({ nodeCount: 4, fileCount: 1, nodesByKind: { function: 2 } }),
      queryApis: () => [],
      queryWorkflows: () => [],
      querySymbols: () => [],
    });
    const result = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'index',
      workspaceRoot: '/tmp/ws',
    });
    expect(result.state).toBe('ready');
    expect(result.partialKnowledge.excludedFromGraphCount).toBe(3);
    expect(result.facets.some((facet) => facet.key === 'workflows')).toBe(false);
    expect(result.facets.some((facet) => facet.key === 'summary')).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it('maps symbols and health dimensions on the ready path', async () => {
    findProjectById.mockResolvedValue(readyProject());
    mockKnowledgeVersion({ sourceVersionId: SOURCE_VERSION_ID, excludedFileCount: 0 });
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: { graph: {}, expired: false, release: () => {} },
      }),
      queryStats: () => ({ nodeCount: 1 }),
      queryApis: () => [],
      queryWorkflows: () => [],
      querySymbols: () => [{ id: 'n1', name: 'refund', filePath: 'p.js', kind: 'function', startLine: 2 }],
    });
    const symbols = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'symbols',
      workspaceRoot: '/tmp/ws',
      query: { q: 're' },
    });
    expect(symbols.items[0].name).toBe('refund');

    listSectionsForVersion.mockResolvedValue([{ heading: 'H', text: 'Body' }]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: {
          graph: { getDetectedFrameworks: () => ['express'] },
          expired: false,
          release: () => {},
        },
      }),
      queryStats: () => ({ nodeCount: 1, fileCount: 1 }),
      queryApis: () => [],
      queryWorkflows: () => [],
      querySymbols: () => [],
    });
    const leasedSummary = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'summary',
      workspaceRoot: '/tmp/ws',
    });
    expect(leasedSummary.summary).toContain('Body');

    listSectionsForVersion.mockResolvedValue([]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: { graph: {}, expired: false, release: () => {} },
      }),
      queryStats: () => ({ nodeCount: 0 }),
      queryApis: () => [],
      queryWorkflows: () => [{ name: 'flow', filePath: 'w.js' }],
      querySymbols: () => [],
    });
    const leasedWorkflows = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'workflows',
      workspaceRoot: '/tmp/ws',
    });
    expect(leasedWorkflows.items[0].title).toBe('flow');

    findProjectById.mockResolvedValue({
      ...readyProject(),
      knowledgeHealth: 'partially_available',
      lifecycleStatus: 'partially_available',
    });
    mockKnowledgeVersion({
      sourceVersionId: SOURCE_VERSION_ID,
      publishedHealth: 'partially_available',
      excludedFileCount: 2,
    });
    const health = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'health',
      workspaceRoot: '/tmp/ws',
    });
    expect(health.state).toBe('ready');
    expect(health.dimensions.exclusions.state).toBe('partial');
    expect(health.partialKnowledge.excludedFromGraphCount).toBe(2);
  });

  it('maps API items and treats mid-query lease expiry as unavailable', async () => {
    findProjectById.mockResolvedValue(readyProject());
    mockKnowledgeVersion({ sourceVersionId: SOURCE_VERSION_ID, excludedFileCount: 0 });
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: { graph: {}, expired: false, release: () => {} },
      }),
      queryStats: () => ({ nodeCount: 1 }),
      queryApis: () => [{ url: '/pay', handler: 'pay', handlerFile: 'r.js', handlerLine: 1 }],
      queryWorkflows: () => [],
      querySymbols: () => [],
    });
    const apis = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'apis',
      workspaceRoot: '/tmp/ws',
    });
    expect(apis.items[0].title).toBe('/pay');

    let expired = false;
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: {
          graph: {},
          get expired() {
            return expired;
          },
          release: () => {},
        },
      }),
      queryStats: () => {
        expired = true;
        return {};
      },
      queryApis: () => [],
      queryWorkflows: () => [{ name: 'flow', filePath: 'w.js' }],
      querySymbols: () => [],
    });
    const expiredResult = await loadKnowledgeBrowse({
      orgId: 'o1',
      projectId: 'p1',
      kind: 'workflows',
      workspaceRoot: '/tmp/ws',
    });
    expect(expiredResult.state).toBe('unavailable');
  });
});
