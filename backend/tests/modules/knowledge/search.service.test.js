/**
 * Unit tests for project search orchestration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findProjectById, assertKnowledgeReadable, findKnowledgeVersionById, searchDocumentSections, createCodegraphAdapter } = vi.hoisted(() => ({
  findProjectById: vi.fn(),
  assertKnowledgeReadable: vi.fn(),
  findKnowledgeVersionById: vi.fn(),
  searchDocumentSections: vi.fn(),
  createCodegraphAdapter: vi.fn(),
}));

vi.mock('../../../src/modules/masters/index.js', () => ({
  findProjectById,
  recordProjectActivity: vi.fn(),
}));

vi.mock('../../../src/modules/knowledge/knowledge.js', () => ({
  assertKnowledgeReadable,
  findKnowledgeVersionById,
}));

vi.mock('../../../src/modules/knowledge/documents.js', () => ({
  searchDocumentSections,
}));

vi.mock('../../../src/modules/knowledge/codegraph.js', () => ({
  createCodegraphAdapter,
}));

import {
  collectGraphSearchItems,
  emptySearchEnvelope,
  pageSearchItems,
  runProjectSearch,
  runProjectSearchFromQuery,
  stateFromGate,
} from '../../../src/modules/knowledge/search.js';
import { encodeSearchCursor } from '../../../src/modules/knowledge/search.js';

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

/**
 * @returns {object}
 */
function refundDocSection() {
  return { _id: 'sec1', path: 'docs/a.md', heading: 'Refunds', text: 'Partial refunds' };
}

describe('runProjectSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchDocumentSections.mockResolvedValue([]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
      querySymbols: () => [],
      queryApis: () => [],
      queryWorkflows: () => [],
    });
  });

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
    findProjectById.mockResolvedValueOnce(null);
    await expect(
      runProjectSearch({ orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', q: 'ab', types: ['doc'], limit: 10 }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    findProjectById.mockResolvedValueOnce({ status: 'D' });
    await expect(
      runProjectSearch({ orgId: 'o1', projectId: 'p1', workspaceRoot: '/tmp/ws', q: 'ab', types: ['doc'], limit: 10 }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('returns updating without searching when the gate queues', async () => {
    findProjectById.mockResolvedValue({ ...readyProject(), knowledgeHealth: 'updating' });
    assertKnowledgeReadable.mockResolvedValue({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });

    const result = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'ab',
      types: ['doc'],
      limit: 10,
    });
    expect(result.state).toBe('updating');
    expect(result.items).toEqual([]);
    expect(searchDocumentSections).not.toHaveBeenCalled();
    expect(createCodegraphAdapter).not.toHaveBeenCalled();
  });

  it('returns unavailable when the gate denies', async () => {
    findProjectById.mockResolvedValue({ ...readyProject(), currentKnowledgeVersionId: null });
    assertKnowledgeReadable.mockResolvedValue({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });

    const result = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'ab',
      types: ['symbol'],
      limit: 10,
    });
    expect(result.state).toBe('unavailable');
    expect(result.items).toEqual([]);
  });

  it('returns docs-only when types is doc and skips the graph lease', async () => {
    findProjectById.mockResolvedValue(readyProject());
    assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: 'kv1' });
    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: 'sv1' });
    searchDocumentSections.mockResolvedValue([refundDocSection()]);

    const result = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'refund',
      types: ['doc'],
      limit: 10,
    });
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].type).toBe('doc');
    expect(createCodegraphAdapter).not.toHaveBeenCalled();
  });

  it('keeps docs and omits graph items when the lease sees a writer', async () => {
    findProjectById.mockResolvedValue(readyProject());
    assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: 'kv1' });
    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: 'sv1' });
    searchDocumentSections.mockResolvedValue([refundDocSection()]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({ ok: false, reason: 'writer' }),
    });

    const result = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'refund',
      types: ['doc', 'symbol'],
      limit: 10,
    });
    expect(result.state).toBe('updating');
    expect(result.items.map((item) => item.type)).toEqual(['doc']);
  });

  it('returns ready docs-only when the graph is missing', async () => {
    findProjectById.mockResolvedValue(readyProject());
    assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: 'kv1' });
    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: 'sv1' });
    searchDocumentSections.mockResolvedValue([refundDocSection()]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
    });

    const result = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'refund',
      types: ['doc', 'symbol'],
      limit: 10,
    });
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1);
  });

  it('returns unavailable and keeps docs when the lease expires', async () => {
    findProjectById.mockResolvedValue(readyProject());
    assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: 'kv1' });
    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: 'sv1' });
    searchDocumentSections.mockResolvedValue([]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({
        ok: true,
        lease: { graph: {}, expired: true, release: () => {} },
      }),
    });

    const result = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'refund',
      types: ['symbol'],
      limit: 10,
    });
    expect(result.state).toBe('unavailable');
    expect(result.items).toEqual([]);
  });

  it('merges graph hits when the lease succeeds and pages with a cursor', async () => {
    const release = vi.fn();
    findProjectById.mockResolvedValue(readyProject());
    assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: 'kv1' });
    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: 'sv1' });
    searchDocumentSections.mockResolvedValue([]);
    createCodegraphAdapter.mockReturnValue({
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
    });

    const result = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'refund',
      types: ['symbol', 'api', 'workflow', 'code'],
      limit: 10,
    });
    expect(result.state).toBe('ready');
    expect(result.items.some((item) => item.type === 'symbol')).toBe(true);
    expect(result.items.some((item) => item.type === 'code')).toBe(true);
    expect(result.items.some((item) => item.type === 'api')).toBe(true);
    expect(release).toHaveBeenCalled();

    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: null });
    createCodegraphAdapter.mockImplementation(() => {
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
    });

    const expiredMid = await runProjectSearch({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      q: 'refund',
      types: ['symbol'],
      limit: 10,
    });
    expect(expiredMid.state).toBe('unavailable');
  });

  it('parses HTTP query and rejects an invalid cursor', async () => {
    findProjectById.mockResolvedValue(readyProject());
    assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: 'kv1' });
    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: 'sv1' });
    searchDocumentSections.mockResolvedValue([]);
    createCodegraphAdapter.mockReturnValue({
      acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
    });

    const ok = await runProjectSearchFromQuery({
      orgId: 'o1',
      projectId: 'p1',
      workspaceRoot: '/tmp/ws',
      query: { q: 'ab', types: 'doc' },
    });
    expect(ok.state).toBe('ready');

    searchDocumentSections.mockResolvedValue([{ _id: '1', path: 'a.md', heading: 'A', text: '' }]);
    await expect(
      runProjectSearch({
        orgId: 'o1',
        projectId: 'p1',
        workspaceRoot: '/tmp/ws',
        q: 'ab',
        types: ['doc'],
        cursor: 'not-a-cursor',
        limit: 10,
      }),
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
      querySymbols: () => [{ name: 'refundHandler', filePath: 'src/a.js', startLine: 1, kind: 'function' }],
      queryApis: () => [{ url: '/orders' }, { url: '/refunds', handlerFile: 'src/a.js' }],
      queryWorkflows: () => [{ title: 'Refund flow', path: 'src/flow.js' }],
    };
    const items = collectGraphSearchItems(adapter, {}, 'refund', ['symbol', 'api', 'workflow'], 'kv1');
    expect(items.some((item) => item.type === 'symbol')).toBe(true);
    expect(items.filter((item) => item.type === 'api')).toHaveLength(1);
    expect(items.some((item) => item.type === 'workflow')).toBe(true);
  });
});
