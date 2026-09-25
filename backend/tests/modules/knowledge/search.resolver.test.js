/**
 * Unit tests for resolveSearchResultForChat.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeOpaqueKey, encodeSearchResultId } from '../../../src/modules/knowledge/search.js';
import { resolveSearchResultForChat } from '../../../src/modules/knowledge/search.js';

/**
 * @returns {object}
 */
function readyProject() {
  return { status: 'A', knowledgeHealth: 'ready', currentKnowledgeVersionId: 'kv1' };
}

describe('resolveSearchResultForChat', () => {
  it('returns SEARCH_RESULT_NOT_FOUND for a malformed or mismatched id', async () => {
    expect(
      await resolveSearchResultForChat({
        orgId: 'o1',
        projectId: 'p1',
        resultId: 'bad',
        workspaceRoot: '/tmp/ws',
      }),
    ).toEqual({ ok: false, code: 'SEARCH_RESULT_NOT_FOUND' });

    expect(
      await resolveSearchResultForChat({
        orgId: 'o1',
        projectId: 'p1',
        resultId: 'kv1:doc:sec1',
        expectedKnowledgeVersionId: 'kv-old',
        workspaceRoot: '/tmp/ws',
      }),
    ).toEqual({ ok: false, code: 'SEARCH_RESULT_NOT_FOUND' });
  });

  it('returns SEARCH_RESULT_NOT_FOUND for a missing project or stale version', async () => {
    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId: 'kv1:doc:sec1', workspaceRoot: '/tmp/ws' },
        { findProject: async () => null },
      ),
    ).toEqual({ ok: false, code: 'SEARCH_RESULT_NOT_FOUND' });

    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId: 'kv-old:doc:sec1', workspaceRoot: '/tmp/ws' },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        },
      ),
    ).toEqual({ ok: false, code: 'SEARCH_RESULT_NOT_FOUND' });
  });

  it('returns KNOWLEDGE_UNAVAILABLE when the gate does not allow', async () => {
    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId: 'kv1:doc:sec1', workspaceRoot: '/tmp/ws' },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'queue', code: 'KNOWLEDGE_UPDATING' }),
        },
      ),
    ).toEqual({ ok: false, code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('re-fetches a document section under the current version', async () => {
    const result = await resolveSearchResultForChat(
      { orgId: 'o1', projectId: 'p1', resultId: 'kv1:doc:sec1', workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        findSection: async () => ({
          _id: 'sec1',
          path: 'docs/a.md',
          heading: 'Refunds',
          text: 'Partial refunds',
          startLine: 1,
          endLine: 3,
        }),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toMatchObject({
        type: 'doc',
        title: 'Refunds',
        sourceRef: { path: 'docs/a.md', sectionId: 'sec1' },
      });
    }
  });

  it('fails closed when the document section is missing', async () => {
    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId: 'kv1:doc:sec1', workspaceRoot: '/tmp/ws' },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
          findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
          findSection: async () => null,
        },
      ),
    ).toEqual({ ok: false, code: 'SEARCH_RESULT_NOT_FOUND' });

    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId: 'kv1:doc:sec1', workspaceRoot: '/tmp/ws' },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
          findKnowledgeVersion: async () => ({}),
        },
      ),
    ).toEqual({ ok: false, code: 'SEARCH_RESULT_NOT_FOUND' });
  });

  it('returns KNOWLEDGE_UNAVAILABLE when a graph lease cannot be taken', async () => {
    const resultId = encodeSearchResultId(
      'kv1',
      'symbol',
      encodeOpaqueKey(['src/a.js', 'refundHandler', 2]),
    );
    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId, workspaceRoot: '/tmp/ws' },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
          findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
          createAdapter: () => ({
            acquireReadLease: async () => ({ ok: false, reason: 'writer' }),
          }),
        },
      ),
    ).toEqual({ ok: false, code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('re-fetches a symbol hit from the graph', async () => {
    const node = { name: 'refundHandler', filePath: 'src/a.js', startLine: 2, kind: 'function' };
    const resultId = encodeSearchResultId(
      'kv1',
      'symbol',
      encodeOpaqueKey(['src/a.js', 'refundHandler', 2]),
    );
    const release = vi.fn();
    const result = await resolveSearchResultForChat(
      { orgId: 'o1', projectId: 'p1', resultId, workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: false, release },
          }),
          querySymbols: () => [node],
          queryApis: () => [],
          queryWorkflows: () => [],
        }),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.title).toBe('refundHandler');
    }
    expect(release).toHaveBeenCalled();
  });

  it('re-fetches api and workflow hits when prefix search misses', async () => {
    const apiId = encodeSearchResultId(
      'kv1',
      'api',
      encodeOpaqueKey(['/refunds', 'src/a.js', 10, 'refundHandler']),
    );
    const apiResult = await resolveSearchResultForChat(
      { orgId: 'o1', projectId: 'p1', resultId: apiId, workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: false, release: () => {} },
          }),
          querySymbols: () => [],
          queryApis: () => [
            { url: '/refunds', handler: 'refundHandler', handlerFile: 'src/a.js', handlerLine: 10 },
          ],
          queryWorkflows: () => [],
        }),
      },
    );
    expect(apiResult.ok).toBe(true);

    const workflowId = encodeSearchResultId(
      'kv1',
      'workflow',
      encodeOpaqueKey(['Checkout', 'src/flow.js', 1, 'wf1']),
    );
    const workflowResult = await resolveSearchResultForChat(
      { orgId: 'o1', projectId: 'p1', resultId: workflowId, workspaceRoot: '/tmp/ws' },
      {
        findProject: async () => readyProject(),
        assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        createAdapter: () => ({
          acquireReadLease: async () => ({
            ok: true,
            lease: { graph: {}, expired: false, release: () => {} },
          }),
          querySymbols: () => [],
          queryApis: () => [],
          queryWorkflows: () => [
            { id: 'wf1', title: 'Checkout', path: 'src/flow.js', startLine: 1 },
          ],
        }),
      },
    );
    expect(workflowResult.ok).toBe(true);
  });

  it('returns not found when the graph hit is gone and when the lease is expired', async () => {
    const resultId = encodeSearchResultId(
      'kv1',
      'symbol',
      encodeOpaqueKey(['src/a.js', 'missing', 1]),
    );
    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId, workspaceRoot: '/tmp/ws' },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
          findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
          createAdapter: () => ({
            acquireReadLease: async () => ({
              ok: true,
              lease: { graph: {}, expired: false, release: () => {} },
            }),
            querySymbols: () => [],
            queryApis: () => [],
            queryWorkflows: () => [],
          }),
        },
      ),
    ).toEqual({ ok: false, code: 'SEARCH_RESULT_NOT_FOUND' });

    expect(
      await resolveSearchResultForChat(
        { orgId: 'o1', projectId: 'p1', resultId, workspaceRoot: '/tmp/ws' },
        {
          findProject: async () => readyProject(),
          assertReadable: async () => ({ action: 'allow', knowledgeVersionId: 'kv1' }),
          findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
          createAdapter: () => ({
            acquireReadLease: async () => ({
              ok: true,
              lease: { graph: {}, expired: true, release: () => {} },
            }),
          }),
        },
      ),
    ).toEqual({ ok: false, code: 'KNOWLEDGE_UNAVAILABLE' });
  });
});
