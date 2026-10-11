/**
 * Scoped Q&A agent tools. Phase 48 calls executeTool; this file owns the
 * six-name registry, tenant scope, evidence ids, and budgeter hand-off.
 */
import { ApiError } from '../../platform/errors.js';
import { findProjectById } from '../masters/index.js';
import { prepareModelInput } from './contextBudgeter.js';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import {
  isDocumentPath,
  listSectionsForPath,
  loadSourceFileSlice,
  createCodegraphAdapter,
  SEARCH_DOC_MAX_RESULTS,
  searchDocumentSections,
  assertKnowledgeReadable,
  findKnowledgeVersionById,
  SEARCH_GRAPH_MAX_RESULTS,
  SEARCH_SNIPPET_MAX_CHARS,
  listDocumentFilesForVersion,
  resolveProjectWorkspacePath,
} from '../knowledge/index.js';

/** Page size for list_documents (matches source-version list default). */
export const LIST_DOCUMENTS_PAGE_SIZE = 20;

/** Hard cap so a tool cannot request an unbounded document page. */
export const LIST_DOCUMENTS_MAX_PAGE_SIZE = 100;

/** Abstain reason codes the model may send. */
export const ABSTAIN_REASON_CODES = Object.freeze(['insufficient_scope', 'user_requested', 'no_support']);

const TOOL_NAMES = Object.freeze(['explore_code', 'search_documents', 'list_documents', 'read_document_slice', 'read_file_slice', 'abstain']);

/**
 * JSON Schema descriptions Phase 48 can pass to the tool-choice prompt.
 * @type {ReadonlyArray<{ name: string, description: string, parameters: object }>}
 */
const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'explore_code',
    description: 'Search the current project code graph for symbols, paths, and snippets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        symbol: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_documents',
    description: 'Full-text search of the current knowledge version document sections.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        pathPrefix: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_documents',
    description: 'List document paths for the current knowledge version. Metadata only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cursor: { type: 'string' },
        pageSize: { type: 'integer' },
      },
    },
  },
  {
    name: 'read_document_slice',
    description: 'Read a bounded heading or line range from a documentation file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        heading: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file_slice',
    description: 'Read a bounded line range from a code or config file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['path', 'startLine', 'endLine'],
    },
  },
  {
    name: 'abstain',
    description: 'Stop retrieval. Do not invent a project answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reasonCode: { type: 'string', enum: [...ABSTAIN_REASON_CODES] },
        message: { type: 'string' },
      },
      required: ['reasonCode', 'message'],
    },
  },
]);

/**
 * Returns the six tool schemas for the Phase 48 tool-choice prompt.
 * @returns {ReadonlyArray<{ name: string, description: string, parameters: object }>}
 */
export function listToolDefinitionsForSchema() {
  return TOOL_DEFINITIONS;
}

/**
 * Executes one named tool under a tenant scope and returns budgeted evidence.
 * @param {{
 *   name: string,
 *   args?: object,
 *   scope: {
 *     orgId: string,
 *     projectId: string,
 *     knowledgeVersionId: string,
 *     workspaceRoot: string,
 *     correlationId?: string,
 *     abortSignal?: AbortSignal,
 *   },
 *   budgetState: object,
 * }} input Call.
 * @returns {Promise<object>}
 * @throws {ApiError} TOOL_UNKNOWN or knowledge/catalog errors.
 */
export async function executeTool(input) {
  if (!TOOL_NAMES.includes(input?.name)) {
    throw ApiError.fromCode('TOOL_UNKNOWN');
  }
  throwIfRunCancelled(input.scope?.abortSignal);

  // Refresh tenant tool scope from the live project row — never from client fields alone.
  const project = await findProjectById(input.scope.orgId, input.scope.projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE || String(project.orgId ?? input.scope.orgId) !== String(input.scope.orgId)) {
    return emptyEvidenceToolResult([toolRejection('scope_mismatch', 'Project is not in the caller tenant scope.')]);
  }

  const currentKnowledgeVersionId = project.currentKnowledgeVersionId ? String(project.currentKnowledgeVersionId) : '';
  if (!currentKnowledgeVersionId || currentKnowledgeVersionId !== String(input.scope.knowledgeVersionId)) {
    return emptyEvidenceToolResult([toolRejection('stale_knowledge_version', 'Knowledge version is not current.')]);
  }

  const knowledgeVersion = await findKnowledgeVersionById({
    orgId: input.scope.orgId,
    projectId: input.scope.projectId,
    knowledgeVersionId: currentKnowledgeVersionId,
  });
  if (!knowledgeVersion?.sourceVersionId) {
    return emptyEvidenceToolResult([toolRejection('stale_knowledge_version', 'Knowledge version is not current.')]);
  }

  let workspacePath;
  try {
    workspacePath = resolveProjectWorkspacePath(input.scope.workspaceRoot, input.scope.orgId, input.scope.projectId);
  } catch {
    return emptyEvidenceToolResult([toolRejection('scope_mismatch', 'Workspace path is not available.')]);
  }

  const scope = {
    orgId: String(input.scope.orgId),
    projectId: String(input.scope.projectId),
    knowledgeVersionId: currentKnowledgeVersionId,
    sourceVersionId: String(knowledgeVersion.sourceVersionId),
    workspaceRoot: input.scope.workspaceRoot,
    workspacePath,
    correlationId: input.scope.correlationId ?? null,
    abortSignal: input.scope.abortSignal,
    nextEvidenceSeq: 0,
  };

  const args = input.args ?? {};
  let raw;
  if (input.name === 'explore_code') {
    raw = await runExploreCodeTool(args, scope);
  } else if (input.name === 'search_documents') {
    raw = await runSearchDocumentsTool(args, scope);
  } else if (input.name === 'list_documents') {
    raw = await runListDocumentsTool(args, scope);
  } else if (input.name === 'read_document_slice') {
    raw = await runReadDocumentSliceTool(args, scope);
  } else if (input.name === 'read_file_slice') {
    raw = await runReadFileSliceTool(args, scope);
  } else {
    const reasonCode = ABSTAIN_REASON_CODES.includes(args.reasonCode) ? args.reasonCode : 'insufficient_scope';
    const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : 'Insufficient evidence.';
    raw = { evidenceRecords: [], rejected: [], stop: { reasonCode, message } };
  }

  const records = raw.evidenceRecords ?? [];
  const rejected = raw.rejected ?? [];
  const stop = raw.stop;
  if (stop) {
    return emptyEvidenceToolResult(rejected, stop);
  }
  if (!input.budgetState?.modelArtifactRef) {
    throw ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE', { details: { reason: 'budget_state_missing' } });
  }
  const segments = records.map((record, index) => ({
    id: record.evidenceId,
    kind: 'tool_result',
    content: record.excerpt ?? '',
    path: record.path,
    sourceId: record.evidenceId,
    rank: records.length - index,
    shrinkable: true,
  }));
  const prepared = prepareModelInput({
    modelArtifactRef: input.budgetState.modelArtifactRef,
    purpose: 'tool_result',
    segments,
    options: input.budgetState.options,
  });
  const droppedIds = new Set(
    (prepared.compactionActions ?? []).filter((action) => action.action === 'drop_tool_body' && action.segmentId).map((action) => action.segmentId),
  );
  /** @type {object[]} */
  const kept = [];
  const nextRejected = [...rejected];
  records.forEach((record, index) => {
    if (droppedIds.has(record.evidenceId)) {
      nextRejected.push(toolRejection('oversized_result', 'Tool excerpt was dropped to fit the context budget.'));
      return;
    }
    const message = prepared.messages[index];
    kept.push({
      ...record,
      excerpt: typeof message?.content === 'string' ? message.content : record.excerpt,
    });
  });
  const resultBytes = kept.reduce((sum, record) => sum + Buffer.byteLength(record.excerpt ?? '', 'utf8'), 0);
  return {
    evidenceRecords: kept,
    rejected: nextRejected,
    usage: {
      resultBytes,
      promptTokensAfterBudget: prepared.measuredInputTokens,
    },
  };
}

/**
 * explore_code — read lease, then buildContext into evidence.
 * @param {object} toolArgs Tool args.
 * @param {object} toolScope Execution scope.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function runExploreCodeTool(toolArgs, toolScope) {
  throwIfRunCancelled(toolScope.abortSignal);
  const gate = await assertKnowledgeReadable({ orgId: toolScope.orgId, projectId: toolScope.projectId });
  if (gate.action !== 'allow') {
    throw ApiError.fromCode(gate.code === 'KNOWLEDGE_UPDATING' ? 'KNOWLEDGE_UPDATING' : 'KNOWLEDGE_UNAVAILABLE');
  }

  const adapter = createCodegraphAdapter();
  const leaseResult = await adapter.acquireReadLease({
    orgId: toolScope.orgId,
    projectId: toolScope.projectId,
    workspacePath: toolScope.workspacePath,
  });
  if (!leaseResult.ok) {
    throw ApiError.fromCode(leaseResult.reason === 'writer' ? 'KNOWLEDGE_UPDATING' : 'KNOWLEDGE_UNAVAILABLE');
  }

  const query = typeof toolArgs.query === 'string' ? toolArgs.query.trim() : '';
  try {
    throwIfRunCancelled(toolScope.abortSignal);
    const result = await adapter.buildContext(leaseResult.lease.graph, {
      query,
      limit: SEARCH_GRAPH_MAX_RESULTS,
    });
    throwIfRunCancelled(toolScope.abortSignal);
    return { evidenceRecords: mapCodegraphExploreToEvidence(toolScope, result, query), rejected: [] };
  } finally {
    leaseResult.lease.release();
  }

  /**
   * Converts adapter.buildContext output into evidence records.
   * Hit→evidence mapping stays inlined here so this nested helper has no further nest.
   * @param {object} evidenceScope Execution scope.
   * @param {unknown} exploreResult Library or fallback payload.
   * @param {string} graphQuery Original query.
   * @returns {object[]}
   */
  function mapCodegraphExploreToEvidence(evidenceScope, exploreResult, graphQuery) {
    if (typeof exploreResult === 'string') {
      const excerpt = clipEvidenceExcerpt(exploreResult);
      if (!excerpt) {
        return [];
      }
      return [
        {
          evidenceId: allocateRunEvidenceId(evidenceScope),
          kind: 'code',
          path: '',
          excerpt,
          knowledgeVersionId: evidenceScope.knowledgeVersionId,
          sourceVersionId: evidenceScope.sourceVersionId,
          provenance: { toolName: 'explore_code', graphQuery },
        },
      ];
    }
    if (!exploreResult || typeof exploreResult !== 'object') {
      return [];
    }
    /** @type {object[]} */
    const records = [];
    const codeBlocks = Array.isArray(exploreResult.codeBlocks) ? exploreResult.codeBlocks : [];
    for (const block of codeBlocks) {
      const hitNode = block?.node && typeof block.node === 'object' ? block.node : block;
      if (!hitNode || typeof hitNode !== 'object') {
        continue;
      }
      const path = typeof hitNode.filePath === 'string' ? hitNode.filePath : typeof hitNode.path === 'string' ? hitNode.path : '';
      if (!path) {
        continue;
      }
      const startLine = Number(hitNode.startLine) || undefined;
      const endLine = Number(hitNode.endLine) || startLine;
      records.push({
        evidenceId: allocateRunEvidenceId(evidenceScope),
        kind: 'code',
        path,
        startLine,
        endLine,
        excerpt: clipEvidenceExcerpt(block.content ?? hitNode.content ?? hitNode.excerpt ?? hitNode.name ?? ''),
        knowledgeVersionId: evidenceScope.knowledgeVersionId,
        sourceVersionId: evidenceScope.sourceVersionId,
        provenance: { toolName: 'explore_code', graphQuery },
      });
    }
    if (records.length > 0) {
      return records;
    }
    const nodes = [
      ...(Array.isArray(exploreResult.entryPoints) ? exploreResult.entryPoints : []),
      ...(Array.isArray(exploreResult.symbols) ? exploreResult.symbols : []),
      ...(Array.isArray(exploreResult.apis) ? exploreResult.apis : []),
    ];
    for (const rawHit of nodes) {
      const hitNode = rawHit?.node && typeof rawHit.node === 'object' ? rawHit.node : rawHit;
      if (!hitNode || typeof hitNode !== 'object') {
        continue;
      }
      const path = typeof hitNode.filePath === 'string' ? hitNode.filePath : typeof hitNode.path === 'string' ? hitNode.path : '';
      if (!path) {
        continue;
      }
      const startLine = Number(hitNode.startLine) || undefined;
      const endLine = Number(hitNode.endLine) || startLine;
      records.push({
        evidenceId: allocateRunEvidenceId(evidenceScope),
        kind: 'code',
        path,
        startLine,
        endLine,
        excerpt: clipEvidenceExcerpt(hitNode.content ?? hitNode.excerpt ?? hitNode.name ?? ''),
        knowledgeVersionId: evidenceScope.knowledgeVersionId,
        sourceVersionId: evidenceScope.sourceVersionId,
        provenance: { toolName: 'explore_code', graphQuery },
      });
    }
    return records;
  }
}

/**
 * search_documents — tenant-scoped Mongo FTS into evidence.
 * @param {object} toolArgs Tool args.
 * @param {object} toolScope Execution scope.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function runSearchDocumentsTool(toolArgs, toolScope) {
  throwIfRunCancelled(toolScope.abortSignal);
  const query = typeof toolArgs.query === 'string' ? toolArgs.query.trim() : '';
  const pathPrefix = typeof toolArgs.pathPrefix === 'string' ? toolArgs.pathPrefix.trim() : undefined;
  const hits = await searchDocumentSections(
    { orgId: toolScope.orgId, projectId: toolScope.projectId, sourceVersionId: toolScope.sourceVersionId },
    { q: query, limit: SEARCH_DOC_MAX_RESULTS, pathPrefix },
  );
  return {
    evidenceRecords: (hits ?? []).flatMap((section) => {
      const path = typeof section.path === 'string' ? section.path : '';
      if (!path) {
        return [];
      }
      return [
        {
          evidenceId: allocateRunEvidenceId(toolScope),
          kind: 'document',
          path,
          heading: typeof section.heading === 'string' ? section.heading : undefined,
          startLine: Number(section.startLine) || undefined,
          endLine: Number(section.endLine) || undefined,
          excerpt: clipEvidenceExcerpt(section.text),
          knowledgeVersionId: toolScope.knowledgeVersionId,
          sourceVersionId: toolScope.sourceVersionId,
          provenance: { toolName: 'search_documents', sectionId: section._id ? String(section._id) : undefined },
        },
      ];
    }),
    rejected: [],
  };
}

/**
 * list_documents — paginated document metadata as evidence rows.
 * @param {object} toolArgs Tool args.
 * @param {object} toolScope Execution scope.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function runListDocumentsTool(toolArgs, toolScope) {
  throwIfRunCancelled(toolScope.abortSignal);
  const rawPage = Number(toolArgs.pageSize);
  const limit = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(Math.floor(rawPage), LIST_DOCUMENTS_MAX_PAGE_SIZE) : LIST_DOCUMENTS_PAGE_SIZE;
  const files = await listDocumentFilesForVersion({
    orgId: toolScope.orgId,
    projectId: toolScope.projectId,
    sourceVersionId: toolScope.sourceVersionId,
    afterPath: typeof toolArgs.cursor === 'string' ? toolArgs.cursor : undefined,
    limit,
  });
  return {
    evidenceRecords: (files ?? []).map((file) => ({
      evidenceId: allocateRunEvidenceId(toolScope),
      kind: 'document',
      path: file.path,
      excerpt: '',
      knowledgeVersionId: toolScope.knowledgeVersionId,
      sourceVersionId: toolScope.sourceVersionId,
      excludedFromGraph: file.excludedFromGraph === true,
      provenance: { toolName: 'list_documents' },
    })),
    rejected: [],
  };
}

/**
 * read_document_slice — docs only.
 * @param {object} toolArgs Tool args.
 * @param {object} toolScope Execution scope.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function runReadDocumentSliceTool(toolArgs, toolScope) {
  const path = typeof toolArgs.path === 'string' ? toolArgs.path : '';
  if (!isDocumentPath(path)) {
    return { evidenceRecords: [], rejected: [toolRejection('wrong_kind', 'read_document_slice only accepts documentation paths.')] };
  }
  const range = await resolveDocumentHeadingRange(toolArgs, toolScope);
  if (range.rejected) {
    return { evidenceRecords: [], rejected: range.rejected };
  }
  return readVersionFileSliceAsEvidence({ ...toolArgs, ...range }, toolScope, 'document', 'read_document_slice');

  /**
   * Resolves a heading to a line range, or uses the requested lines.
   * @param {object} sliceArgs Tool args.
   * @param {object} sliceScope Execution scope.
   * @returns {Promise<{ startLine: number, endLine: number, heading?: string } | { rejected: object[] }>}
   */
  async function resolveDocumentHeadingRange(sliceArgs, sliceScope) {
    const heading = typeof sliceArgs.heading === 'string' ? sliceArgs.heading.trim() : '';
    if (!heading) {
      return { startLine: Number(sliceArgs.startLine), endLine: Number(sliceArgs.endLine) };
    }
    const sections = await listSectionsForPath({
      orgId: sliceScope.orgId,
      projectId: sliceScope.projectId,
      sourceVersionId: sliceScope.sourceVersionId,
      path: sliceArgs.path,
    });
    const match = (sections ?? []).find((section) => section.heading === heading);
    if (!match) {
      return { rejected: [toolRejection('not_found', 'Heading was not found in this document.')] };
    }
    return { startLine: match.startLine, endLine: match.endLine, heading };
  }
}

/**
 * read_file_slice — code/config only.
 * @param {object} toolArgs Tool args.
 * @param {object} toolScope Execution scope.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function runReadFileSliceTool(toolArgs, toolScope) {
  const path = typeof toolArgs.path === 'string' ? toolArgs.path : '';
  if (isDocumentPath(path)) {
    return { evidenceRecords: [], rejected: [toolRejection('wrong_kind', 'read_file_slice does not accept documentation paths.')] };
  }
  return readVersionFileSliceAsEvidence(toolArgs, toolScope, 'code', 'read_file_slice');
}

/**
 * Builds a log-only reject row for the agent tool loop.
 * @param {string} code Machine reason.
 * @param {string} message Safe description.
 * @returns {{ code: string, message: string }}
 */
function toolRejection(code, message) {
  return { code, message };
}

/**
 * Mints the next run-scoped evidence id (ev_01, ev_02, …).
 * @param {{ nextEvidenceSeq: number }} scope Mutable scope.
 * @returns {string}
 */
function allocateRunEvidenceId(scope) {
  scope.nextEvidenceSeq += 1;
  return `ev_${String(scope.nextEvidenceSeq).padStart(2, '0')}`;
}

/**
 * Bounds evidence excerpt text for the prompt.
 * @param {unknown} text Raw excerpt.
 * @param {number} [maxChars] Character cap.
 * @returns {string}
 */
function clipEvidenceExcerpt(text, maxChars = SEARCH_SNIPPET_MAX_CHARS) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

/**
 * Throws when the Q&A run abort signal has already fired.
 * @param {AbortSignal | undefined} abortSignal Run cancel.
 * @returns {void}
 * @throws {Error} AbortError when cancelled.
 */
function throwIfRunCancelled(abortSignal) {
  if (!abortSignal?.aborted) {
    return;
  }
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  throw error;
}

/**
 * Empty successful tool payload (no evidence).
 * @param {object[]} rejected Reject rows.
 * @param {{ reasonCode: string, message: string }} [stop] Abstain payload.
 * @returns {object}
 */
function emptyEvidenceToolResult(rejected, stop) {
  return {
    evidenceRecords: [],
    rejected,
    usage: { resultBytes: 0, promptTokensAfterBudget: 0 },
    ...(stop ? { stop } : {}),
  };
}

/**
 * Shared GridFS slice → one evidence record (docs or code).
 * @param {object} args Path and lines.
 * @param {object} scope Execution scope.
 * @param {'document' | 'code'} kind Evidence kind.
 * @param {string} toolName Provenance name.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function readVersionFileSliceAsEvidence(args, scope, kind, toolName) {
  throwIfRunCancelled(scope.abortSignal);
  try {
    const slice = await loadSourceFileSlice({
      orgId: scope.orgId,
      projectId: scope.projectId,
      path: args.path,
      startLine: args.startLine,
      endLine: args.endLine,
    });
    throwIfRunCancelled(scope.abortSignal);
    return {
      evidenceRecords: [
        {
          evidenceId: allocateRunEvidenceId(scope),
          kind,
          path: slice.path,
          startLine: slice.startLine,
          endLine: slice.endLine,
          heading: args.heading,
          excerpt: clipEvidenceExcerpt(slice.content, SEARCH_SNIPPET_MAX_CHARS * 4),
          knowledgeVersionId: scope.knowledgeVersionId,
          sourceVersionId: slice.sourceVersionId ?? scope.sourceVersionId,
          excludedFromGraph: slice.excludedFromGraph === true,
          provenance: { toolName },
        },
      ],
      rejected: [],
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'SOURCE_NOT_FOUND') {
      return { evidenceRecords: [], rejected: [toolRejection('not_found', 'Path was not found in the current version.')] };
    }
    throw error;
  }
}
