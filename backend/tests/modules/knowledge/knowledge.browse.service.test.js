/**
 * Unit tests for knowledge browse orchestration.
 */
import { describe, expect, it, vi } from 'vitest';
import { clampBrowseLimit, loadKnowledgeBrowse } from '../../../src/modules/knowledge/knowledge.js';

/**
 * @returns {object}
 */
function readyProject() {
  return {
    status: 'A',
    name: 'Atlas',
    knowledgeHealth: 'ready',
    lifecycleStatus: 'knowledge_ready',
    currentKnowledgeVersionId: 'kv1',
  };
}

describe('loadKnowledgeBrowse', () => {
  it('clamps browse page size', () => {
    expect(clampBrowseLimit(undefined)).toBe(50);
    expect(clampBrowseLimit(0)).toBe(50);
    expect(clampBrowseLimit(1000)).toBe(100);
    expect(clampBrowseLimit(12)).toBe(12);
  });

  it('throws PROJECT_NOT_FOUND for a missing or soft-deleted project', async () => {
    await expect(
      loadKnowledgeBrowse(
        { orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' },
        { findProject: async () => null },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    await expect(
      loadKnowledgeBrowse(
        { orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' },
        { findProject: async () => ({ status: 'D' }) },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('returns updating without acquiring a graph when the gate queues', async () => {
    const createAdapter = vi.fn();
    const result = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => ({
          ...readyProject(),
          knowledgeHealth: 'updating',
          lifecycleStatus: 'updating',
        }),
        assertReadable: async () => ({ action: 'queue', code: 'KNOWLEDGE_UPDATING' }),
        createAdapter,
      },
    );
    expect(result.state).toBe('updating');
    expect(result.items).toEqual([]);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('returns unavailable when the gate denies', async () => {
    const result = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'symbols', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => ({
          ...readyProject(),
          knowledgeHealth: 'failed',
          currentKnowledgeVersionId: null,
        }),
        assertReadable: async () => ({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' }),
      },
    );
    expect(result.state).toBe('unavailable');
    expect(result.items).toEqual([]);
  });

  it('returns ready summary and matching version id from docs when the graph is missing', async () => {
    const result = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({
          sourceVersionId: 'sv1',
          publishedHealth: 'ready',
          excludedFileCount: 0,
        }),
        listSections: async () => [{ heading: 'Intro', text: 'Payments service.' }],
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
        }),
      },
    );
    expect(result.state).toBe('ready');
    expect(result.knowledgeVersionId).toBe('kv1');
    expect(result.summary).toContain('Payments service.');

    const indexOnly = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'index', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [{ heading: 'Intro', text: 'Payments service.' }],
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
        }),
      },
    );
    expect(indexOnly.facets.some((facet) => facet.key === 'documentation')).toBe(true);

    const emptyGraphLists = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'apis', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ excludedFileCount: 0 }),
        listSections: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
        }),
      },
    );
    expect(emptyGraphLists.items).toEqual([]);
  });

  it('returns updating when the lease sees a writer', async () => {
    const result = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'symbols', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'writer' }),
        }),
      },
    );
    expect(result.state).toBe('updating');
    expect(result.items).toEqual([]);
  });

  it('returns unavailable when the lease expires mid-query', async () => {
    const result = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: true, release: () => {} },
          }),
        }),
      },
    );
    expect(result.state).toBe('unavailable');
  });

  it('returns ready graph payloads and omits empty facets', async () => {
    const release = vi.fn();
    const result = await loadKnowledgeBrowse(
      {
        orgId: 'o1',
        projectId: 'p1',
        kind: 'index',
        workspaceRoot: '/tmp/ws',
      },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({
          sourceVersionId: 'sv1',
          publishedHealth: 'partially_available',
          excludedFileCount: 3,
        }),
        listSections: async () => [{ heading: 'Docs', text: 'Hello' }],
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: false, release },
          }),
          queryStats: () => ({ nodeCount: 4, fileCount: 1, nodesByKind: { function: 2 } }),
          queryApis: () => [],
          queryWorkflows: () => [],
          querySymbols: () => [],
        }),
      },
    );
    expect(result.state).toBe('ready');
    expect(result.partialKnowledge.excludedFromGraphCount).toBe(3);
    expect(result.facets.some((facet) => facet.key === 'workflows')).toBe(false);
    expect(result.facets.some((facet) => facet.key === 'summary')).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it('maps symbols and health dimensions on the ready path', async () => {
    const symbols = await loadKnowledgeBrowse(
      {
        orgId: 'o1',
        projectId: 'p1',
        kind: 'symbols',
        workspaceRoot: '/tmp/ws',
        query: { q: 're' },
      },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: false, release: () => {} },
          }),
          queryStats: () => ({ nodeCount: 1 }),
          queryApis: () => [],
          queryWorkflows: () => [],
          querySymbols: () => [
            { id: 'n1', name: 'refund', filePath: 'p.js', kind: 'function', startLine: 2 },
          ],
        }),
      },
    );
    expect(symbols.items[0].name).toBe('refund');

    const leasedSummary = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'summary', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [{ heading: 'H', text: 'Body' }],
        createAdapter: () => ({
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
        }),
      },
    );
    expect(leasedSummary.summary).toContain('Body');

    const leasedWorkflows = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'workflows', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: false, release: () => {} },
          }),
          queryStats: () => ({ nodeCount: 0 }),
          queryApis: () => [],
          queryWorkflows: () => [{ name: 'flow', filePath: 'w.js' }],
          querySymbols: () => [],
        }),
      },
    );
    expect(leasedWorkflows.items[0].title).toBe('flow');

    const health = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'health', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => ({
          ...readyProject(),
          knowledgeHealth: 'partially_available',
        }),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({
          sourceVersionId: 'sv1',
          publishedHealth: 'partially_available',
          excludedFileCount: 2,
        }),
        listSections: async () => [],
      },
    );
    expect(health.state).toBe('ready');
    expect(health.dimensions.exclusions.state).toBe('partial');
    expect(health.partialKnowledge.excludedFromGraphCount).toBe(2);
  });

  it('maps API items and treats mid-query lease expiry as unavailable', async () => {
    const apis = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'apis', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: false, release: () => {} },
          }),
          queryStats: () => ({ nodeCount: 1 }),
          queryApis: () => [{ url: '/pay', handler: 'pay', handlerFile: 'r.js', handlerLine: 1 }],
          queryWorkflows: () => [],
          querySymbols: () => [],
        }),
      },
    );
    expect(apis.items[0].title).toBe('/pay');

    let expired = false;
    const expiredResult = await loadKnowledgeBrowse(
      { orgId: 'o1', projectId: 'p1', kind: 'workflows', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1', excludedFileCount: 0 }),
        listSections: async () => [],
        createAdapter: () => ({
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
        }),
      },
    );
    expect(expiredResult.state).toBe('unavailable');
  });
});
