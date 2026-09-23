/**
 * Unit tests for project search orchestration.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collectGraphSearchItems,
  emptySearchEnvelope,
  pageSearchItems,
  runProjectSearch,
  runProjectSearchFromQuery,
  stateFromGate,
} from './search.service.js';
import { encodeSearchCursor } from './search.ids.js';

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

describe('runProjectSearch', () => {
  it('maps gate actions and empty envelopes', () => {
    expect(stateFromGate('allow')).toBe('ready');
    expect(stateFromGate('queue')).toBe('updating');
    expect(stateFromGate('deny')).toBe('unavailable');
    expect(emptySearchEnvelope('updating', { q: 'ab', knowledgeVersionId: 'kv1' })).toMatchObject({
      state: 'updating',
      q: 'ab',
      items: [],
      cursor: null,
    });
  });

  it('throws PROJECT_NOT_FOUND for a missing or soft-deleted project', async () => {
    await expect(
      runProjectSearch(
        { orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', q: 'ab', types: ['doc'], limit: 10 },
        { findProject: async () => null },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(
      runProjectSearch(
        { orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', q: 'ab', types: ['doc'], limit: 10 },
        { findProject: async () => ({ status: 'D' }) },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('returns updating without searching when the gate queues', async () => {
    const searchDocuments = vi.fn();
    const createAdapter = vi.fn();
    const result = await runProjectSearch(
      { orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', q: 'ab', types: ['doc'], limit: 10 },
      {
        findProject: async () => ({ ...readyProject(), knowledgeHealth: 'updating' }),
        assertReadable: async () => ({ action: 'queue', code: 'KNOWLEDGE_UPDATING' }),
        searchDocuments,
        createAdapter,
      },
    );
    expect(result.state).toBe('updating');
    expect(result.items).toEqual([]);
    expect(searchDocuments).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('returns unavailable when the gate denies', async () => {
    const result = await runProjectSearch(
      { orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', q: 'ab', types: ['symbol'], limit: 10 },
      {
        findProject: async () => ({ ...readyProject(), currentKnowledgeVersionId: null }),
        assertReadable: async () => ({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' }),
      },
    );
    expect(result.state).toBe('unavailable');
    expect(result.items).toEqual([]);
  });

  it('returns docs-only when types is doc and skips the graph lease', async () => {
    const createAdapter = vi.fn();
    const result = await runProjectSearch(
      { orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', q: 'refund', types: ['doc'], limit: 10 },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        searchDocuments: async () => [
          {
            id: 'kv1:doc:sec1',
            type: 'doc',
            title: 'Refunds',
            snippet: 'Partial',
            sourceRef: { path: 'docs/a.md', sectionId: 'sec1' },
            score: null,
          },
        ],
        createAdapter,
      },
    );
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].type).toBe('doc');
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('keeps docs and omits graph items when the lease sees a writer', async () => {
    const result = await runProjectSearch(
      {
        orgId: 'o1',
        projectId: 'p1',
        workspaceRoot: '/tmp/ws',
        q: 'refund',
        types: ['doc', 'symbol'],
        limit: 10,
      },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        searchDocuments: async () => [
          {
            id: 'kv1:doc:sec1',
            type: 'doc',
            title: 'Refunds',
            snippet: 'Partial',
            sourceRef: { path: 'docs/a.md' },
            score: null,
          },
        ],
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'writer' }),
        }),
      },
    );
    expect(result.state).toBe('updating');
    expect(result.items.map((item) => item.type)).toEqual(['doc']);
  });

  it('returns ready docs-only when the graph is missing', async () => {
    const result = await runProjectSearch(
      {
        orgId: 'o1',
        projectId: 'p1',
        workspaceRoot: '/tmp/ws',
        q: 'refund',
        types: ['doc', 'symbol'],
        limit: 10,
      },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        searchDocuments: async () => [
          {
            id: 'kv1:doc:sec1',
            type: 'doc',
            title: 'Refunds',
            snippet: 'Partial',
            sourceRef: { path: 'docs/a.md' },
            score: null,
          },
        ],
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
        }),
      },
    );
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1);
  });

  it('returns unavailable and keeps docs when the lease expires', async () => {
    const result = await runProjectSearch(
      {
        orgId: 'o1',
        projectId: 'p1',
        workspaceRoot: '/tmp/ws',
        q: 'refund',
        types: ['symbol'],
        limit: 10,
      },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        searchDocuments: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: true, release: () => {} },
          }),
        }),
      },
    );
    expect(result.state).toBe('unavailable');
    expect(result.items).toEqual([]);
  });

  it('merges graph hits when the lease succeeds and pages with a cursor', async () => {
    const release = vi.fn();
    const result = await runProjectSearch(
      {
        orgId: 'o1',
        projectId: 'p1',
        workspaceRoot: '/tmp/ws',
        q: 'refund',
        types: ['symbol', 'api', 'workflow', 'code'],
        limit: 10,
      },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        searchDocuments: async () => [],
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: { marker: true }, expired: false, release },
          }),
          querySymbols: () => [
            { name: 'refundHandler', filePath: 'src/a.js', startLine: 2, kind: 'function' },
            { name: 'refund.js', filePath: 'src/refund.js', startLine: 1, kind: 'file' },
          ],
          queryApis: () => [{ url: '/refunds', handler: 'refundHandler', handlerFile: 'src/a.js' }],
          queryWorkflows: () => [],
        }),
      },
    );
    expect(result.state).toBe('ready');
    expect(result.items.some((item) => item.type === 'symbol')).toBe(true);
    expect(result.items.some((item) => item.type === 'code')).toBe(true);
    expect(result.items.some((item) => item.type === 'api')).toBe(true);
    expect(release).toHaveBeenCalled();

    const expiredMid = await runProjectSearch(
      {
        orgId: 'o1',
        projectId: 'p1',
        workspaceRoot: '/tmp/ws',
        q: 'refund',
        types: ['symbol'],
        limit: 10,
      },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: null }),
        searchDocuments: async () => [],
        createAdapter: () => {
          const lease = { graph: {}, expired: false, release: () => {} };
          return {
            acquireReadLease: async () => ({ ok: true, lease }),
            querySymbols: () => {
              lease.expired = true;
              return [{ name: 'x', filePath: 'a.js', startLine: 1 }];
            },
            queryApis: () => [],
            queryWorkflows: () => [],
          };
        },
      },
    );
    expect(expiredMid.state).toBe('unavailable');
  });

  it('parses HTTP query and rejects an invalid cursor', async () => {
    const ok = await runProjectSearchFromQuery(
      { orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', query: { q: 'ab', types: 'doc' } },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        searchDocuments: async () => [],
        createAdapter: () => ({ acquireReadLease: async () => ({ ok: false, reason: 'missing' }) }),
      },
    );
    expect(ok.state).toBe('ready');

    await expect(
      runProjectSearch(
        {
          orgId: 'o1',
          projectId: 'p1',
          workspaceRoot: '/tmp/ws',
          q: 'ab',
          types: ['doc'],
          cursor: 'not-a-cursor',
          limit: 10,
        },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
          findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
          searchDocuments: async () => [
            {
              id: 'kv1:doc:1',
              type: 'doc',
              title: 'A',
              snippet: '',
              sourceRef: { path: 'a.md' },
              score: null,
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('pages after a valid cursor', () => {
    const items = [
      { type: 'doc', title: 'A', id: '1' },
      { type: 'doc', title: 'B', id: '2' },
      { type: 'doc', title: 'C', id: '3' },
    ];
    const first = pageSearchItems(items, undefined, 1);
    expect(first.items).toHaveLength(1);
    expect(first.cursor).toBeTruthy();
    const second = pageSearchItems(items, first.cursor, 10);
    expect(second.items.map((item) => item.title)).toEqual(['B', 'C']);
    expect(second.cursor).toBeNull();
    const encoded = encodeSearchCursor(items[1]);
    expect(pageSearchItems(items, encoded, 1).items[0].title).toBe('C');
  });

  it('collects only matching graph types', () => {
    const adapter = {
      querySymbols: () => [
        { name: 'refundHandler', filePath: 'src/a.js', startLine: 1, kind: 'function' },
      ],
      queryApis: () => [{ url: '/orders' }, { url: '/refunds', handlerFile: 'src/a.js' }],
      queryWorkflows: () => [{ title: 'Refund flow', path: 'src/flow.js' }],
    };
    const items = collectGraphSearchItems(adapter, {}, 'refund', ['symbol', 'api', 'workflow'], 'kv1');
    expect(items.some((item) => item.type === 'symbol')).toBe(true);
    expect(items.filter((item) => item.type === 'api')).toHaveLength(1);
    expect(items.some((item) => item.type === 'workflow')).toBe(true);
  });
});
