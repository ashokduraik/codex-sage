/**
 * Unit tests for the six scoped agent tools: registry, tenant scope, evidence
 * mapping, budgeter hand-off, and abort — with masters/knowledge seams mocked.
 */
import { ApiError } from '../../../src/platform/errors.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findProjectById } from '../../../src/modules/masters/index.js';
import { LIST_DOCUMENTS_PAGE_SIZE } from '../../../src/modules/conversation/agentTools.js';
import { executeTool, listToolDefinitionsForSchema } from '../../../src/modules/conversation/index.js';
import {
  isDocumentPath,
  listSectionsForPath,
  loadSourceFileSlice,
  createCodegraphAdapter,
  searchDocumentSections,
  assertKnowledgeReadable,
  findKnowledgeVersionById,
  listDocumentFilesForVersion,
  resolveProjectWorkspacePath,
} from '../../../src/modules/knowledge/index.js';

const { countTokensForBudget } = vi.hoisted(() => ({
  countTokensForBudget: vi.fn((text) => {
    const trimmed = String(text ?? '').trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  }),
}));

vi.mock('../../../src/modules/conversation/tokenCount.js', () => ({
  countTokensForBudget: (...args) => countTokensForBudget(...args),
}));

vi.mock('../../../src/modules/masters/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findProjectById: vi.fn(),
  };
});

vi.mock('../../../src/modules/knowledge/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    assertKnowledgeReadable: vi.fn(),
    createCodegraphAdapter: vi.fn(),
    findKnowledgeVersionById: vi.fn(),
    isDocumentPath: vi.fn(),
    listDocumentFilesForVersion: vi.fn(),
    listSectionsForPath: vi.fn(),
    loadSourceFileSlice: vi.fn(),
    resolveProjectWorkspacePath: vi.fn(),
    searchDocumentSections: vi.fn(),
  };
});

const MODEL = 'test-model';

/**
 * Generous budget that will not compact typical fixtures.
 * @param {object} [overrides] Extra budgetState fields.
 * @returns {object}
 */
function budgetState(overrides = {}) {
  const { options: optionOverrides, ...rest } = overrides;
  return {
    modelArtifactRef: MODEL,
    options: {
      validatedContextCapacity: 10_000,
      reservedOutputTokens: 0,
      ...optionOverrides,
      llm: optionOverrides?.llm ?? { contextCapacity: 10_000, artifactId: MODEL },
    },
    ...rest,
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

/**
 * Mirrors production isDocumentPath so wrong_kind tests stay realistic.
 * @param {unknown} filePath Candidate path.
 * @returns {boolean}
 */
function documentPathByExtension(filePath) {
  const lower = String(filePath ?? '').toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt');
}

beforeEach(() => {
  vi.resetAllMocks();
  countTokensForBudget.mockImplementation((text) => {
    const trimmed = String(text ?? '').trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  });
  findProjectById.mockResolvedValue(readyProject());
  findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: 'sv1' });
  resolveProjectWorkspacePath.mockReturnValue('/tmp/workspaces/o1/p1');
  assertKnowledgeReadable.mockResolvedValue({ action: 'allow' });
  isDocumentPath.mockImplementation(documentPathByExtension);
  searchDocumentSections.mockResolvedValue([]);
  listDocumentFilesForVersion.mockResolvedValue([]);
  listSectionsForPath.mockResolvedValue([]);
  loadSourceFileSlice.mockRejectedValue(ApiError.fromCode('SOURCE_NOT_FOUND'));
  createCodegraphAdapter.mockReturnValue({
    acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
    buildContext: async () => ({}),
  });
});

describe('listToolDefinitionsForSchema', () => {
  it('lists exactly the six MVP tool names', () => {
    const names = listToolDefinitionsForSchema().map((tool) => tool.name);
    expect(names).toEqual(['explore_code', 'search_documents', 'list_documents', 'read_document_slice', 'read_file_slice', 'abstain']);
    expect(LIST_DOCUMENTS_PAGE_SIZE).toBe(20);
  });
});

describe('executeTool registry', () => {
  it('throws TOOL_UNKNOWN for an unregistered name', async () => {
    await expect(executeTool(toolInput('shell'))).rejects.toMatchObject({
      code: 'TOOL_UNKNOWN',
    });
  });
});

describe('executeTool scope', () => {
  it('rejects a forged org or missing project', async () => {
    findProjectById.mockResolvedValueOnce(null);
    const missing = await executeTool(toolInput('search_documents', { query: 'x' }, { orgId: 'other' }));
    expect(missing).toEqual({
      evidenceRecords: [],
      rejected: [{ code: 'scope_mismatch', message: 'Project is not in the caller tenant scope.' }],
      usage: { resultBytes: 0, promptTokensAfterBudget: 0 },
    });

    findProjectById.mockResolvedValueOnce(readyProject({ status: 'D' }));
    const deleted = await executeTool(toolInput('search_documents', { query: 'x' }));
    expect(deleted.rejected[0].code).toBe('scope_mismatch');

    findProjectById.mockResolvedValueOnce(readyProject({ orgId: 'other' }));
    const otherOrg = await executeTool(toolInput('search_documents', { query: 'x' }));
    expect(otherOrg.rejected[0].code).toBe('scope_mismatch');
  });

  it('rejects a stale knowledge version', async () => {
    const stale = await executeTool(toolInput('search_documents', { query: 'x' }, { knowledgeVersionId: 'old' }));
    expect(stale).toEqual({
      evidenceRecords: [],
      rejected: [{ code: 'stale_knowledge_version', message: 'Knowledge version is not current.' }],
      usage: { resultBytes: 0, promptTokensAfterBudget: 0 },
    });
  });

  it('rejects when the knowledge version row is missing a source', async () => {
    findKnowledgeVersionById.mockResolvedValueOnce({});
    const missingSource = await executeTool(toolInput('search_documents', { query: 'x' }));
    expect(missingSource.rejected[0].code).toBe('stale_knowledge_version');
  });

  it('rejects when the workspace path cannot be resolved', async () => {
    resolveProjectWorkspacePath.mockImplementationOnce(() => {
      throw new Error('bad root');
    });
    const failed = await executeTool(toolInput('search_documents', { query: 'x' }, { workspaceRoot: 'relative' }));
    expect(failed.rejected[0].code).toBe('scope_mismatch');
  });

  it('returns empty evidence when the scope is stale', async () => {
    const result = await executeTool(toolInput('search_documents', { query: 'x' }, { knowledgeVersionId: 'old' }));
    expect(result.evidenceRecords).toEqual([]);
    expect(result.rejected[0].code).toBe('stale_knowledge_version');
    expect(result.usage.resultBytes).toBe(0);
  });
});

describe('abstain', () => {
  it('returns zero evidence records and a structured stop payload', async () => {
    const result = await executeTool(toolInput('abstain', { reasonCode: 'no_support', message: 'Docs do not cover this.' }));
    expect(result.evidenceRecords).toEqual([]);
    expect(result.stop).toEqual({ reasonCode: 'no_support', message: 'Docs do not cover this.' });
    expect(result.usage.promptTokensAfterBudget).toBe(0);
  });

  it('falls back to a safe reason when the code is unknown', async () => {
    const result = await executeTool(toolInput('abstain', { reasonCode: 'nope', message: '   ' }));
    expect(result.stop.reasonCode).toBe('insufficient_scope');
    expect(result.stop.message).toBe('Insufficient evidence.');
  });
});

describe('search_documents', () => {
  it('passes tenant, version, and query into the document search helper', async () => {
    searchDocumentSections.mockResolvedValueOnce([
      {
        _id: 'sec1',
        path: 'docs/refunds.md',
        heading: 'Refunds',
        startLine: 1,
        endLine: 4,
        text: 'Partial refunds are allowed.',
      },
    ]);
    const result = await executeTool(toolInput('search_documents', { query: 'refunds', pathPrefix: 'docs/' }));
    expect(searchDocumentSections).toHaveBeenCalledWith(
      { orgId: 'o1', projectId: 'p1', sourceVersionId: 'sv1' },
      { q: 'refunds', limit: 15, pathPrefix: 'docs/' },
    );
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
    searchDocumentSections.mockResolvedValueOnce([{ _id: 'sec1', path: 'docs/a.md', text: 'word '.repeat(200) }]);
    const result = await executeTool(toolInput('search_documents', { query: 'x' }));
    expect(result.evidenceRecords[0].excerpt.length).toBeLessThanOrEqual(280);
  });

  it('skips search hits that have no path', async () => {
    searchDocumentSections.mockResolvedValueOnce([{ _id: 'sec1', text: 'no path' }]);
    const result = await executeTool(toolInput('search_documents', { query: 'x' }));
    expect(result.evidenceRecords).toEqual([]);
  });

  it('returns empty evidence when FTS has no hits', async () => {
    searchDocumentSections.mockResolvedValueOnce([]);
    const result = await executeTool(toolInput('search_documents', { query: 'missing' }));
    expect(result.evidenceRecords).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe('list_documents', () => {
  it('returns metadata-only rows and labels graph-excluded docs', async () => {
    listDocumentFilesForVersion.mockResolvedValueOnce([
      { path: 'docs/a.md', excludedFromGraph: false },
      { path: 'docs/big.md', excludedFromGraph: true },
    ]);
    const result = await executeTool(toolInput('list_documents', { cursor: 'a.md', pageSize: 5 }));
    expect(listDocumentFilesForVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'o1',
        sourceVersionId: 'sv1',
        afterPath: 'a.md',
        limit: 5,
      }),
    );
    expect(result.evidenceRecords.map((row) => row.excludedFromGraph)).toEqual([false, true]);
    expect(result.evidenceRecords[0].excerpt).toBe('');
    expect(result.evidenceRecords[1].evidenceId).toBe('ev_02');
  });

  it('defaults the document page size when the request is not a positive integer', async () => {
    listDocumentFilesForVersion.mockResolvedValueOnce([]);
    await executeTool(toolInput('list_documents', { pageSize: 0 }));
    expect(listDocumentFilesForVersion).toHaveBeenCalledWith(expect.objectContaining({ limit: LIST_DOCUMENTS_PAGE_SIZE }));
  });

  it('treats a null document list as empty', async () => {
    listDocumentFilesForVersion.mockResolvedValueOnce(null);
    const result = await executeTool(toolInput('list_documents'));
    expect(result.evidenceRecords).toEqual([]);
  });
});

describe('read slices', () => {
  it('rejects path escape and absolute paths on both slice tools', async () => {
    loadSourceFileSlice.mockRejectedValue(ApiError.fromCode('VALIDATION_ERROR'));
    await expect(executeTool(toolInput('read_file_slice', { path: '../etc/passwd', startLine: 1, endLine: 2 }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(executeTool(toolInput('read_file_slice', { path: '/etc/passwd', startLine: 1, endLine: 2 }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(executeTool(toolInput('read_document_slice', { path: '../secret.md', startLine: 1, endLine: 2 }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects the wrong file kind for each slice tool', async () => {
    const doc = await executeTool(toolInput('read_document_slice', { path: 'src/a.js', startLine: 1, endLine: 2 }));
    expect(doc.rejected[0].code).toBe('wrong_kind');
    const code = await executeTool(toolInput('read_file_slice', { path: 'README.md', startLine: 1, endLine: 2 }));
    expect(code.rejected[0].code).toBe('wrong_kind');
  });

  it('reads a document by line range when no heading is given', async () => {
    loadSourceFileSlice.mockResolvedValueOnce({
      path: 'notes.txt',
      startLine: 1,
      endLine: 1,
      content: 'hello',
      sourceVersionId: 'sv1',
      excludedFromGraph: true,
    });
    const result = await executeTool(toolInput('read_document_slice', { path: 'notes.txt', startLine: 1, endLine: 1 }));
    expect(result.evidenceRecords[0]).toMatchObject({
      kind: 'document',
      excludedFromGraph: true,
      excerpt: 'hello',
    });
  });

  it('returns the requested line range for a code file', async () => {
    loadSourceFileSlice.mockResolvedValueOnce({
      path: 'src/a.js',
      startLine: 2,
      endLine: 3,
      content: 'two\nthree',
      sourceVersionId: 'sv1',
      excludedFromGraph: false,
    });
    const result = await executeTool(toolInput('read_file_slice', { path: 'src/a.js', startLine: 2, endLine: 3 }));
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
    listSectionsForPath.mockResolvedValueOnce([{ heading: 'Refunds', startLine: 2, endLine: 3 }]);
    loadSourceFileSlice.mockResolvedValueOnce({
      path: 'docs/a.md',
      startLine: 2,
      endLine: 3,
      content: '# Refunds\nAllowed.',
      sourceVersionId: 'sv1',
      excludedFromGraph: false,
    });
    const result = await executeTool(toolInput('read_document_slice', { path: 'docs/a.md', heading: 'Refunds' }));
    expect(result.evidenceRecords[0]).toMatchObject({
      kind: 'document',
      heading: 'Refunds',
      startLine: 2,
    });
    expect(loadSourceFileSlice).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'docs/a.md',
        startLine: 2,
        endLine: 3,
      }),
    );
  });

  it('rejects a missing heading or missing file without inventing content', async () => {
    listSectionsForPath.mockResolvedValueOnce([]);
    const missingHeading = await executeTool(toolInput('read_document_slice', { path: 'docs/a.md', heading: 'Nope' }));
    expect(missingHeading.evidenceRecords).toEqual([]);
    expect(missingHeading.rejected[0].code).toBe('not_found');

    loadSourceFileSlice.mockRejectedValueOnce(ApiError.fromCode('SOURCE_NOT_FOUND'));
    const missingFile = await executeTool(toolInput('read_file_slice', { path: 'src/missing.js', startLine: 1, endLine: 2 }));
    expect(missingFile.rejected[0].code).toBe('not_found');
  });
});

describe('explore_code', () => {
  it('acquires and releases the read lease on success and maps hits', async () => {
    const release = vi.fn();
    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: { id: 'g' }, release } }),
      buildContext: async (_graph, input) => {
        expect(input.query).toBe('login');
        return {
          codeBlocks: [{ filePath: 'src/auth.js', startLine: 4, endLine: 8, content: 'function login() {}' }],
        };
      },
    });
    const result = await executeTool(toolInput('explore_code', { query: 'login' }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(result.evidenceRecords[0]).toMatchObject({
      evidenceId: 'ev_01',
      kind: 'code',
      path: 'src/auth.js',
      provenance: { toolName: 'explore_code', graphQuery: 'login' },
    });
  });

  it('maps fallback symbol and API hits when buildContext has no code blocks', async () => {
    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
      buildContext: async () => ({
        symbols: [{ filePath: 'src/auth.js', startLine: 1, name: 'login' }],
        apis: [{ node: { path: 'src/routes.js', startLine: 10, endLine: 12 } }],
      }),
    });
    const result = await executeTool(toolInput('explore_code', { query: 'auth' }));
    expect(result.evidenceRecords.map((row) => row.path)).toEqual(['src/auth.js', 'src/routes.js']);
  });

  it('maps a string buildContext payload and ignores hits without a path', async () => {
    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
      buildContext: async () => '### src/hello.js\nexport const codexSageE2eHello = "hello";',
    });
    const stringed = await executeTool(toolInput('explore_code', { query: 'x' }));
    expect(stringed.evidenceRecords[0].path).toBe('src/hello.js');
    expect(stringed.evidenceRecords[0].excerpt).toContain('codexSageE2eHello');

    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
      buildContext: async () => 'relevant context about login with no file path',
    });
    const pathlessString = await executeTool(toolInput('explore_code', { query: 'x' }));
    expect(pathlessString.evidenceRecords).toEqual([]);

    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
      buildContext: async () => ({ symbols: [{ name: 'no-path' }], apis: null }),
    });
    const empty = await executeTool(toolInput('explore_code', { query: 'x' }));
    expect(empty.evidenceRecords).toEqual([]);

    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
      buildContext: async () => '',
    });
    const blank = await executeTool(toolInput('explore_code', { query: 'x' }));
    expect(blank.evidenceRecords).toEqual([]);

    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
      buildContext: async () => 0,
    });
    const invalid = await executeTool(toolInput('explore_code', { query: 'x' }));
    expect(invalid.evidenceRecords).toEqual([]);

    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release: () => {} } }),
      buildContext: async () => ({ codeBlocks: [null, { name: 'no-path' }] }),
    });
    const badBlocks = await executeTool(toolInput('explore_code', { query: 'x' }));
    expect(badBlocks.evidenceRecords).toEqual([]);
  });

  it('releases the read lease when buildContext throws', async () => {
    const release = vi.fn();
    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: true, lease: { graph: {}, release } }),
      buildContext: async () => {
        throw new Error('adapter failed');
      },
    });
    await expect(executeTool(toolInput('explore_code', { query: 'x' }))).rejects.toThrow('adapter failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('throws KNOWLEDGE_UPDATING or KNOWLEDGE_UNAVAILABLE from the gate or lease', async () => {
    assertKnowledgeReadable.mockResolvedValueOnce({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });
    await expect(executeTool(toolInput('explore_code', { query: 'x' }))).rejects.toMatchObject({ code: 'KNOWLEDGE_UPDATING' });

    assertKnowledgeReadable.mockResolvedValueOnce({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });
    await expect(executeTool(toolInput('explore_code', { query: 'x' }))).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' });

    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: false, reason: 'writer' }),
    });
    await expect(executeTool(toolInput('explore_code', { query: 'x' }))).rejects.toMatchObject({ code: 'KNOWLEDGE_UPDATING' });

    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => ({ ok: false, reason: 'missing' }),
    });
    await expect(executeTool(toolInput('explore_code', { query: 'x' }))).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('does not acquire a lease when the run is already aborted', async () => {
    await expect(executeTool(toolInput('explore_code', { query: 'x' }, { abortSignal: { aborted: true } }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(createCodegraphAdapter).not.toHaveBeenCalled();
  });

  it('aborts after the lease is taken and still releases it', async () => {
    const release = vi.fn();
    const abortSignal = { aborted: false };
    createCodegraphAdapter.mockReturnValueOnce({
      acquireReadLease: async () => {
        abortSignal.aborted = true;
        return { ok: true, lease: { graph: {}, release } };
      },
      buildContext: async () => ({ symbols: [{ filePath: 'src/a.js', name: 'a' }] }),
    });
    await expect(executeTool(toolInput('explore_code', { query: 'x' }, { abortSignal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('budgeter', () => {
  it('drops the lowest-ranked oversized excerpt and reports usage', async () => {
    const tight = budgetState({
      options: {
        validatedContextCapacity: 7,
        reservedOutputTokens: 0,
      },
    });
    searchDocumentSections.mockResolvedValueOnce([
      { _id: 'a', path: 'docs/a.md', text: 'alpha beta gamma delta' },
      { _id: 'b', path: 'docs/b.md', text: 'one two three four' },
    ]);
    const result = await executeTool({
      ...toolInput('search_documents', { query: 'x' }),
      budgetState: tight,
    });
    expect(result.rejected.some((row) => row.code === 'oversized_result')).toBe(true);
    expect(result.evidenceRecords.length).toBeLessThan(2);
    expect(result.usage.promptTokensAfterBudget).toBeGreaterThan(0);
    expect(result.usage.resultBytes).toBeGreaterThan(0);
  });

  it('fails closed when budget state is missing', async () => {
    searchDocumentSections.mockResolvedValueOnce([{ _id: 'a', path: 'docs/a.md', text: 'hello' }]);
    await expect(executeTool({ ...toolInput('search_documents', { query: 'x' }), budgetState: {} })).rejects.toMatchObject({
      code: 'CONTEXT_ACCOUNTING_UNAVAILABLE',
    });
  });
});

describe('executeTool abort before dispatch', () => {
  it('throws AbortError when the run is already cancelled', async () => {
    await expect(executeTool(toolInput('list_documents', {}, { abortSignal: { aborted: true } }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
