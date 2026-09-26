/**
 * Unit tests for the six scoped agent tools and their tenant/budget guards.
 */
import { describe, expect, it, vi } from 'vitest';
import { LIST_DOCUMENTS_PAGE_SIZE } from '../../../src/modules/conversation/agentTools.js';
import {
  buildToolExecutionScope,
  createTokenizerAdapter,
  executeTool,
  listToolDefinitionsForSchema,
} from '../../../src/modules/conversation/index.js';

const MODEL = 'test-model';

/**
 * Word-count tokenizer so budget tests stay deterministic.
 * @param {string} text Segment text.
 * @returns {number}
 */
function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Generous budget that will not compact typical fixtures.
 * @param {object} [overrides] Extra budgetState fields.
 * @returns {object}
 */
function budgetState(overrides = {}) {
  return {
    modelArtifactRef: MODEL,
    options: {
      tokenizer: createTokenizerAdapter({
        countTokens: countWords,
        expectedArtifactId: MODEL,
      }),
      validatedContextCapacity: 10_000,
      reservedOutputTokens: 0,
    },
    ...overrides,
  };
}

/**
 * Active project row used by scope refresh.
 * @param {object} [overrides] Project fields.
 * @returns {object}
 */
function readyProject(overrides = {}) {
  return {
    status: 'A',
    orgId: 'o1',
    currentKnowledgeVersionId: 'kv1',
    ...overrides,
  };
}

/**
 * Default injected seams so unit tests do not hit Mongo or disk.
 * @param {object} [overrides] Extra deps.
 * @returns {object}
 */
function defaultDeps(overrides = {}) {
  return {
    findProject: async () => readyProject(),
    findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
    resolveWorkspacePath: () => '/tmp/workspaces/o1/p1',
    ...overrides,
  };
}

/**
 * Builds executeTool input for one named tool.
 * @param {string} name Tool name.
 * @param {object} [args] Tool args.
 * @param {object} [scopeOverrides] Scope fields.
 * @returns {object}
 */
function toolInput(name, args = {}, scopeOverrides = {}) {
  return {
    name,
    args,
    scope: {
      orgId: 'o1',
      projectId: 'p1',
      knowledgeVersionId: 'kv1',
      workspaceRoot: '/tmp/workspaces',
      ...scopeOverrides,
    },
    budgetState: budgetState(),
  };
}

describe('listToolDefinitionsForSchema', () => {
  it('lists exactly the six MVP tool names', () => {
    const names = listToolDefinitionsForSchema().map((tool) => tool.name);
    expect(names).toEqual(['explore_code', 'search_documents', 'list_documents', 'read_document_slice', 'read_file_slice', 'abstain']);
    expect(LIST_DOCUMENTS_PAGE_SIZE).toBe(20);
  });
});

describe('executeTool registry', () => {
  it('throws TOOL_UNKNOWN for an unregistered name', async () => {
    await expect(executeTool(toolInput('shell'), {}, defaultDeps())).rejects.toMatchObject({
      code: 'TOOL_UNKNOWN',
    });
  });
});

describe('buildToolExecutionScope', () => {
  it('rejects a forged org or missing project', async () => {
    const missing = await buildToolExecutionScope(
      { orgId: 'other', projectId: 'p1', knowledgeVersionId: 'kv1', workspaceRoot: '/tmp/workspaces' },
      { findProject: async () => null },
    );
    expect(missing).toEqual({
      ok: false,
      rejected: [{ code: 'scope_mismatch', message: 'Project is not in the caller tenant scope.' }],
    });

    const deleted = await buildToolExecutionScope(
      { orgId: 'o1', projectId: 'p1', knowledgeVersionId: 'kv1', workspaceRoot: '/tmp/workspaces' },
      { findProject: async () => readyProject({ status: 'D' }) },
    );
    expect(deleted.ok).toBe(false);
    expect(deleted.rejected[0].code).toBe('scope_mismatch');

    const otherOrg = await buildToolExecutionScope(
      { orgId: 'o1', projectId: 'p1', knowledgeVersionId: 'kv1', workspaceRoot: '/tmp/workspaces' },
      { findProject: async () => readyProject({ orgId: 'other' }) },
    );
    expect(otherOrg.rejected[0].code).toBe('scope_mismatch');
  });

  it('rejects a stale knowledge version', async () => {
    const stale = await buildToolExecutionScope(
      { orgId: 'o1', projectId: 'p1', knowledgeVersionId: 'old', workspaceRoot: '/tmp/workspaces' },
      defaultDeps(),
    );
    expect(stale).toEqual({
      ok: false,
      rejected: [{ code: 'stale_knowledge_version', message: 'Knowledge version is not current.' }],
    });
  });

  it('rejects when the knowledge version row is missing a source', async () => {
    const missingSource = await buildToolExecutionScope(
      { orgId: 'o1', projectId: 'p1', knowledgeVersionId: 'kv1', workspaceRoot: '/tmp/workspaces' },
      {
        ...defaultDeps(),
        findKnowledgeVersion: async () => ({}),
      },
    );
    expect(missingSource.rejected[0].code).toBe('stale_knowledge_version');
  });

  it('rejects when the workspace path cannot be resolved', async () => {
    const failed = await buildToolExecutionScope(
      { orgId: 'o1', projectId: 'p1', knowledgeVersionId: 'kv1', workspaceRoot: 'relative' },
      {
        ...defaultDeps(),
        resolveWorkspacePath: () => {
          throw new Error('bad root');
        },
      },
    );
    expect(failed.rejected[0].code).toBe('scope_mismatch');
  });
});

describe('executeTool scope refresh', () => {
  it('returns empty evidence when the scope is stale', async () => {
    const result = await executeTool(toolInput('search_documents', { query: 'x' }, { knowledgeVersionId: 'old' }), defaultDeps());
    expect(result.evidenceRecords).toEqual([]);
    expect(result.rejected[0].code).toBe('stale_knowledge_version');
    expect(result.usage.resultBytes).toBe(0);
  });
});

describe('abstain', () => {
  it('returns zero evidence records and a structured stop payload', async () => {
    const result = await executeTool(toolInput('abstain', { reasonCode: 'no_support', message: 'Docs do not cover this.' }), defaultDeps());
    expect(result.evidenceRecords).toEqual([]);
    expect(result.stop).toEqual({ reasonCode: 'no_support', message: 'Docs do not cover this.' });
    expect(result.usage.promptTokensAfterBudget).toBe(0);
  });

  it('falls back to a safe reason when the code is unknown', async () => {
    const result = await executeTool(toolInput('abstain', { reasonCode: 'nope', message: '   ' }), defaultDeps());
    expect(result.stop.reasonCode).toBe('insufficient_scope');
    expect(result.stop.message).toBe('Insufficient evidence.');
  });
});

describe('search_documents', () => {
  it('passes tenant, version, and query into the document search helper', async () => {
    /** @type {object | null} */
    let captured = null;
    const result = await executeTool(toolInput('search_documents', { query: 'refunds', pathPrefix: 'docs/' }), {
      ...defaultDeps(),
      searchDocumentSections: async (scope, options) => {
        captured = { scope, options };
        return [
          {
            _id: 'sec1',
            path: 'docs/refunds.md',
            heading: 'Refunds',
            startLine: 1,
            endLine: 4,
            text: 'Partial refunds are allowed.',
          },
        ];
      },
    });
    expect(captured).toEqual({
      scope: { orgId: 'o1', projectId: 'p1', sourceVersionId: 'sv1' },
      options: { q: 'refunds', limit: 15, pathPrefix: 'docs/' },
    });
    expect(result.evidenceRecords).toHaveLength(1);
    expect(result.evidenceRecords[0]).toMatchObject({
      evidenceId: 'ev_01',
      kind: 'document',
      path: 'docs/refunds.md',
      knowledgeVersionId: 'kv1',
      provenance: { toolName: 'search_documents', sectionId: 'sec1' },
    });
  });

  it('caps long document excerpts', async () => {
    const result = await executeTool(toolInput('search_documents', { query: 'x' }), {
      ...defaultDeps(),
      searchDocumentSections: async () => [{ _id: 'sec1', path: 'docs/a.md', text: 'word '.repeat(200) }],
    });
    expect(result.evidenceRecords[0].excerpt.length).toBeLessThanOrEqual(280);
  });

  it('skips search hits that have no path', async () => {
    const result = await executeTool(toolInput('search_documents', { query: 'x' }), {
      ...defaultDeps(),
      searchDocumentSections: async () => [{ _id: 'sec1', text: 'no path' }],
    });
    expect(result.evidenceRecords).toEqual([]);
  });

  it('returns empty evidence when FTS has no hits', async () => {
    const result = await executeTool(toolInput('search_documents', { query: 'missing' }), {
      ...defaultDeps(),
      searchDocumentSections: async () => [],
    });
    expect(result.evidenceRecords).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe('list_documents', () => {
  it('returns metadata-only rows and labels graph-excluded docs', async () => {
    const result = await executeTool(toolInput('list_documents', { cursor: 'a.md', pageSize: 5 }), {
      ...defaultDeps(),
      listDocumentFilesForVersion: async (input) => {
        expect(input).toMatchObject({
          orgId: 'o1',
          sourceVersionId: 'sv1',
          afterPath: 'a.md',
          limit: 5,
        });
        return [
          { path: 'docs/a.md', excludedFromGraph: false },
          { path: 'docs/big.md', excludedFromGraph: true },
        ];
      },
    });
    expect(result.evidenceRecords.map((row) => row.excludedFromGraph)).toEqual([false, true]);
    expect(result.evidenceRecords[0].excerpt).toBe('');
    expect(result.evidenceRecords[1].evidenceId).toBe('ev_02');
  });

  it('defaults the document page size when the request is not a positive integer', async () => {
    /** @type {number | undefined} */
    let limit;
    await executeTool(toolInput('list_documents', { pageSize: 0 }), {
      ...defaultDeps(),
      listDocumentFilesForVersion: async (input) => {
        limit = input.limit;
        return [];
      },
    });
    expect(limit).toBe(LIST_DOCUMENTS_PAGE_SIZE);
  });

  it('treats a null document list as empty', async () => {
    const result = await executeTool(toolInput('list_documents'), {
      ...defaultDeps(),
      listDocumentFilesForVersion: async () => null,
    });
    expect(result.evidenceRecords).toEqual([]);
  });
});

describe('read slices', () => {
  it('rejects path escape and absolute paths on both slice tools', async () => {
    const deps = defaultDeps();
    await expect(executeTool(toolInput('read_file_slice', { path: '../etc/passwd', startLine: 1, endLine: 2 }), deps)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(executeTool(toolInput('read_file_slice', { path: '/etc/passwd', startLine: 1, endLine: 2 }), deps)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(executeTool(toolInput('read_document_slice', { path: '../secret.md', startLine: 1, endLine: 2 }), deps)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects the wrong file kind for each slice tool', async () => {
    const doc = await executeTool(toolInput('read_document_slice', { path: 'src/a.js', startLine: 1, endLine: 2 }), defaultDeps());
    expect(doc.rejected[0].code).toBe('wrong_kind');
    const code = await executeTool(toolInput('read_file_slice', { path: 'README.md', startLine: 1, endLine: 2 }), defaultDeps());
    expect(code.rejected[0].code).toBe('wrong_kind');
  });

  it('reads a document by line range when no heading is given', async () => {
    const result = await executeTool(toolInput('read_document_slice', { path: 'notes.txt', startLine: 1, endLine: 1 }), {
      ...defaultDeps(),
      findFile: async () => ({ path: 'notes.txt', gridFsId: 'g1', excludedFromGraph: true }),
      readBytes: async () => Buffer.from('hello'),
    });
    expect(result.evidenceRecords[0]).toMatchObject({
      kind: 'document',
      excludedFromGraph: true,
      excerpt: 'hello',
    });
  });

  it('returns the requested line range for a code file', async () => {
    const result = await executeTool(toolInput('read_file_slice', { path: 'src/a.js', startLine: 2, endLine: 3 }), {
      ...defaultDeps(),
      findFile: async () => ({ path: 'src/a.js', gridFsId: 'g1', excludedFromGraph: false }),
      readBytes: async () => Buffer.from('one\ntwo\nthree\nfour'),
    });
    expect(result.evidenceRecords[0]).toMatchObject({
      evidenceId: 'ev_01',
      kind: 'code',
      path: 'src/a.js',
      startLine: 2,
      endLine: 3,
      excerpt: 'two\nthree',
    });
  });

  it('resolves a document heading then reads that slice', async () => {
    const result = await executeTool(toolInput('read_document_slice', { path: 'docs/a.md', heading: 'Refunds' }), {
      ...defaultDeps(),
      listSectionsForPath: async () => [{ heading: 'Refunds', startLine: 2, endLine: 3 }],
      findFile: async () => ({ path: 'docs/a.md', gridFsId: 'g1', excludedFromGraph: false }),
      readBytes: async () => Buffer.from('# Intro\n# Refunds\nAllowed.\n'),
    });
    expect(result.evidenceRecords[0]).toMatchObject({
      kind: 'document',
      heading: 'Refunds',
      startLine: 2,
    });
  });

  it('rejects a missing heading or missing file without inventing content', async () => {
    const missingHeading = await executeTool(toolInput('read_document_slice', { path: 'docs/a.md', heading: 'Nope' }), {
      ...defaultDeps(),
      listSectionsForPath: async () => [],
    });
    expect(missingHeading.evidenceRecords).toEqual([]);
    expect(missingHeading.rejected[0].code).toBe('not_found');

    const missingFile = await executeTool(toolInput('read_file_slice', { path: 'src/missing.js', startLine: 1, endLine: 2 }), {
      ...defaultDeps(),
      findFile: async () => null,
    });
    expect(missingFile.rejected[0].code).toBe('not_found');
  });
});

describe('explore_code', () => {
  it('acquires and releases the read lease on success and maps hits', async () => {
    const release = vi.fn();
    const result = await executeTool(toolInput('explore_code', { query: 'login' }), {
      ...defaultDeps(),
      assertKnowledgeReadable: async () => ({ action: 'allow' }),
      createAdapter: () => ({
        acquireReadLease: async () => ({ ok: true, lease: { graph: { id: 'g' }, release } }),
        buildContext: async (_graph, input) => {
          expect(input.query).toBe('login');
          return {
            codeBlocks: [{ filePath: 'src/auth.js', startLine: 4, endLine: 8, content: 'function login() {}' }],
          };
        },
      }),
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(result.evidenceRecords[0]).toMatchObject({
      evidenceId: 'ev_01',
      kind: 'code',
      path: 'src/auth.js',
      provenance: { toolName: 'explore_code', graphQuery: 'login' },
    });
  });

  it('maps fallback symbol and API hits when buildContext has no code blocks', async () => {
    const result = await executeTool(toolInput('explore_code', { query: 'auth' }), {
      ...defaultDeps(),
      assertKnowledgeReadable: async () => ({ action: 'allow' }),
      createAdapter: () => ({
        acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
        buildContext: async () => ({
          symbols: [{ filePath: 'src/auth.js', startLine: 1, name: 'login' }],
          apis: [{ node: { path: 'src/routes.js', startLine: 10, endLine: 12 } }],
        }),
      }),
    });
    expect(result.evidenceRecords.map((row) => row.path)).toEqual(['src/auth.js', 'src/routes.js']);
  });

  it('maps a string buildContext payload and ignores hits without a path', async () => {
    const stringed = await executeTool(toolInput('explore_code', { query: 'x' }), {
      ...defaultDeps(),
      assertKnowledgeReadable: async () => ({ action: 'allow' }),
      createAdapter: () => ({
        acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
        buildContext: async () => 'relevant context about login',
      }),
    });
    expect(stringed.evidenceRecords[0].excerpt).toContain('relevant context');

    const empty = await executeTool(toolInput('explore_code', { query: 'x' }), {
      ...defaultDeps(),
      assertKnowledgeReadable: async () => ({ action: 'allow' }),
      createAdapter: () => ({
        acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
        buildContext: async () => ({ symbols: [{ name: 'no-path' }], apis: null }),
      }),
    });
    expect(empty.evidenceRecords).toEqual([]);

    const blank = await executeTool(toolInput('explore_code', { query: 'x' }), {
      ...defaultDeps(),
      assertKnowledgeReadable: async () => ({ action: 'allow' }),
      createAdapter: () => ({
        acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
        buildContext: async () => '',
      }),
    });
    expect(blank.evidenceRecords).toEqual([]);

    const invalid = await executeTool(toolInput('explore_code', { query: 'x' }), {
      ...defaultDeps(),
      assertKnowledgeReadable: async () => ({ action: 'allow' }),
      createAdapter: () => ({
        acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
        buildContext: async () => 0,
      }),
    });
    expect(invalid.evidenceRecords).toEqual([]);

    const badBlocks = await executeTool(toolInput('explore_code', { query: 'x' }), {
      ...defaultDeps(),
      assertKnowledgeReadable: async () => ({ action: 'allow' }),
      createAdapter: () => ({
        acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
        buildContext: async () => ({ codeBlocks: [null, { name: 'no-path' }] }),
      }),
    });
    expect(badBlocks.evidenceRecords).toEqual([]);
  });

  it('releases the read lease when buildContext throws', async () => {
    const release = vi.fn();
    await expect(
      executeTool(toolInput('explore_code', { query: 'x' }), {
        ...defaultDeps(),
        assertKnowledgeReadable: async () => ({ action: 'allow' }),
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release } }),
          buildContext: async () => {
            throw new Error('adapter failed');
          },
        }),
      }),
    ).rejects.toThrow('adapter failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('throws KNOWLEDGE_UPDATING or KNOWLEDGE_UNAVAILABLE from the gate or lease', async () => {
    await expect(
      executeTool(toolInput('explore_code', { query: 'x' }), {
        ...defaultDeps(),
        assertKnowledgeReadable: async () => ({ action: 'queue', code: 'KNOWLEDGE_UPDATING' }),
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_UPDATING' });

    await expect(
      executeTool(toolInput('explore_code', { query: 'x' }), {
        ...defaultDeps(),
        assertKnowledgeReadable: async () => ({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' }),
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' });

    await expect(
      executeTool(toolInput('explore_code', { query: 'x' }), {
        ...defaultDeps(),
        assertKnowledgeReadable: async () => ({ action: 'allow' }),
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'writer' }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_UPDATING' });

    await expect(
      executeTool(toolInput('explore_code', { query: 'x' }), {
        ...defaultDeps(),
        assertKnowledgeReadable: async () => ({ action: 'allow' }),
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('releases the lease and does not append evidence when aborted', async () => {
    const release = vi.fn();
    const abortSignal = { aborted: true };
    await expect(
      executeTool(toolInput('explore_code', { query: 'x' }, { abortSignal }), {
        ...defaultDeps(),
        assertKnowledgeReadable: async () => ({ action: 'allow' }),
        createAdapter: () => ({
          acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release } }),
          buildContext: async () => ({ symbols: [{ filePath: 'src/a.js', name: 'a' }] }),
        }),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).not.toHaveBeenCalled();
  });

  it('aborts after the lease is taken and still releases it', async () => {
    const release = vi.fn();
    const abortSignal = { aborted: false };
    await expect(
      executeTool(toolInput('explore_code', { query: 'x' }, { abortSignal }), {
        ...defaultDeps(),
        assertKnowledgeReadable: async () => ({ action: 'allow' }),
        createAdapter: () => ({
          acquireReadLease: async () => {
            abortSignal.aborted = true;
            return { ok: true, lease: { graph: {}, release } };
          },
          buildContext: async () => ({ symbols: [{ filePath: 'src/a.js', name: 'a' }] }),
        }),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('budgeter', () => {
  it('drops the lowest-ranked oversized excerpt and reports usage', async () => {
    const tight = budgetState({
      options: {
        tokenizer: createTokenizerAdapter({
          countTokens: countWords,
          expectedArtifactId: MODEL,
        }),
        validatedContextCapacity: 7,
        reservedOutputTokens: 0,
      },
    });
    const result = await executeTool(
      {
        ...toolInput('search_documents', { query: 'x' }),
        budgetState: tight,
      },
      {
        ...defaultDeps(),
        searchDocumentSections: async () => [
          { _id: 'a', path: 'docs/a.md', text: 'alpha beta gamma delta' },
          { _id: 'b', path: 'docs/b.md', text: 'one two three four' },
        ],
      },
    );
    expect(result.rejected.some((row) => row.code === 'oversized_result')).toBe(true);
    expect(result.evidenceRecords.length).toBeLessThan(2);
    expect(result.usage.promptTokensAfterBudget).toBeGreaterThan(0);
    expect(result.usage.resultBytes).toBeGreaterThan(0);
  });

  it('fails closed when budget state is missing', async () => {
    await expect(
      executeTool(
        { ...toolInput('search_documents', { query: 'x' }), budgetState: {} },
        {
          ...defaultDeps(),
          searchDocumentSections: async () => [{ _id: 'a', path: 'docs/a.md', text: 'hello' }],
        },
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_ACCOUNTING_UNAVAILABLE' });
  });
});

describe('executeTool abort before dispatch', () => {
  it('throws AbortError when the run is already cancelled', async () => {
    await expect(executeTool(toolInput('list_documents', {}, { abortSignal: { aborted: true } }), defaultDeps())).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
