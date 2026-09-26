/**
 * Scoped Q&A agent tools. Phase 48 calls executeTool; this file owns the
 * six-name registry, tenant scope, evidence ids, and budgeter hand-off.
 */
import { ApiError } from '../../platform/errors.js';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { findProjectById } from '../masters/index.js';
import {
  SEARCH_DOC_MAX_RESULTS,
  SEARCH_GRAPH_MAX_RESULTS,
  SEARCH_SNIPPET_MAX_CHARS,
  assertKnowledgeReadable,
  createCodegraphAdapter,
  findKnowledgeVersionById,
  isDocumentPath,
  listDocumentFilesForVersion,
  listSectionsForPath,
  loadSourceFileSlice,
  resolveProjectWorkspacePath,
  searchDocumentSections,
} from '../knowledge/index.js';
import { prepareModelInput } from './contextBudgeter.js';

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
 * Builds a log-only reject row.
 * @param {string} code Machine reason.
 * @param {string} message Safe description.
 * @returns {{ code: string, message: string }}
 */
function reject(code, message) {
  return { code, message };
}

/**
 * Mints the next run-scoped evidence id (ev_01, ev_02, …).
 * @param {{ nextEvidenceSeq: number }} scope Mutable scope.
 * @returns {string}
 */
function nextEvidenceId(scope) {
  scope.nextEvidenceSeq += 1;
  return `ev_${String(scope.nextEvidenceSeq).padStart(2, '0')}`;
}

/**
 * Caps excerpt text for prompt use.
 * @param {unknown} text Raw excerpt.
 * @param {number} [maxChars] Character cap.
 * @returns {string}
 */
function capExcerpt(text, maxChars = SEARCH_SNIPPET_MAX_CHARS) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

/**
 * Throws when the run abort signal has already fired.
 * @param {AbortSignal | undefined} abortSignal Run cancel.
 * @returns {void}
 * @throws {Error} AbortError when cancelled.
 */
function throwIfAborted(abortSignal) {
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
function emptyToolResult(rejected, stop) {
  return {
    evidenceRecords: [],
    rejected,
    usage: { resultBytes: 0, promptTokensAfterBudget: 0 },
    ...(stop ? { stop } : {}),
  };
}

/**
 * Builds tenant scope from the live project row — never from client fields alone.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   knowledgeVersionId: string,
 *   workspaceRoot: string,
 *   correlationId?: string,
 *   abortSignal?: AbortSignal,
 * }} input Run identity.
 * @param {{
 *   findProject?: Function,
 *   findKnowledgeVersion?: Function,
 *   resolveWorkspacePath?: Function,
 * }} [deps] Test seams.
 * @returns {Promise<{ ok: true, scope: object } | { ok: false, rejected: object[] }>}
 */
export async function buildToolExecutionScope(input, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const findKnowledgeVersion = deps.findKnowledgeVersion ?? findKnowledgeVersionById;
  const resolveWorkspace = deps.resolveWorkspacePath ?? resolveProjectWorkspacePath;

  const project = await findProject(input.orgId, input.projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE || String(project.orgId ?? input.orgId) !== String(input.orgId)) {
    return { ok: false, rejected: [reject('scope_mismatch', 'Project is not in the caller tenant scope.')] };
  }

  const currentKnowledgeVersionId = project.currentKnowledgeVersionId ? String(project.currentKnowledgeVersionId) : '';
  if (!currentKnowledgeVersionId || currentKnowledgeVersionId !== String(input.knowledgeVersionId)) {
    return { ok: false, rejected: [reject('stale_knowledge_version', 'Knowledge version is not current.')] };
  }

  const knowledgeVersion = await findKnowledgeVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    knowledgeVersionId: currentKnowledgeVersionId,
  });
  if (!knowledgeVersion?.sourceVersionId) {
    return { ok: false, rejected: [reject('stale_knowledge_version', 'Knowledge version is not current.')] };
  }

  let workspacePath;
  try {
    workspacePath = resolveWorkspace(input.workspaceRoot, input.orgId, input.projectId);
  } catch {
    return { ok: false, rejected: [reject('scope_mismatch', 'Workspace path is not available.')] };
  }

  return {
    ok: true,
    scope: {
      orgId: String(input.orgId),
      projectId: String(input.projectId),
      knowledgeVersionId: currentKnowledgeVersionId,
      sourceVersionId: String(knowledgeVersion.sourceVersionId),
      workspaceRoot: input.workspaceRoot,
      workspacePath,
      correlationId: input.correlationId ?? null,
      abortSignal: input.abortSignal,
      nextEvidenceSeq: 0,
    },
  };
}

/**
 * Maps a raw graph hit into an evidence record when a path is present.
 * @param {object} scope Execution scope.
 * @param {object} raw Library row.
 * @param {string} graphQuery Original query.
 * @returns {object | null}
 */
function mapGraphHitToEvidence(scope, raw, graphQuery) {
  const node = raw?.node && typeof raw.node === 'object' ? raw.node : raw;
  if (!node || typeof node !== 'object') {
    return null;
  }
  const path = typeof node.filePath === 'string' ? node.filePath : typeof node.path === 'string' ? node.path : '';
  if (!path) {
    return null;
  }
  const startLine = Number(node.startLine) || undefined;
  const endLine = Number(node.endLine) || startLine;
  const excerpt = capExcerpt(node.content ?? node.excerpt ?? node.name ?? '');
  return {
    evidenceId: nextEvidenceId(scope),
    kind: 'code',
    path,
    startLine,
    endLine,
    excerpt,
    knowledgeVersionId: scope.knowledgeVersionId,
    sourceVersionId: scope.sourceVersionId,
    provenance: { toolName: 'explore_code', graphQuery },
  };
}

/**
 * Converts adapter.buildContext output into evidence records.
 * @param {object} scope Execution scope.
 * @param {unknown} result Library or fallback payload.
 * @param {string} graphQuery Original query.
 * @returns {object[]}
 */
function mapExploreResult(scope, result, graphQuery) {
  if (typeof result === 'string') {
    const excerpt = capExcerpt(result);
    if (!excerpt) {
      return [];
    }
    return [
      {
        evidenceId: nextEvidenceId(scope),
        kind: 'code',
        path: '',
        excerpt,
        knowledgeVersionId: scope.knowledgeVersionId,
        sourceVersionId: scope.sourceVersionId,
        provenance: { toolName: 'explore_code', graphQuery },
      },
    ];
  }
  if (!result || typeof result !== 'object') {
    return [];
  }
  /** @type {object[]} */
  const records = [];
  const codeBlocks = Array.isArray(result.codeBlocks) ? result.codeBlocks : [];
  for (const block of codeBlocks) {
    const mapped = mapGraphHitToEvidence(scope, block, graphQuery);
    if (mapped) {
      mapped.excerpt = capExcerpt(block.content ?? mapped.excerpt);
      records.push(mapped);
    }
  }
  if (records.length > 0) {
    return records;
  }
  const nodes = [
    ...(Array.isArray(result.entryPoints) ? result.entryPoints : []),
    ...(Array.isArray(result.symbols) ? result.symbols : []),
    ...(Array.isArray(result.apis) ? result.apis : []),
  ];
  for (const node of nodes) {
    const mapped = mapGraphHitToEvidence(scope, node, graphQuery);
    if (mapped) {
      records.push(mapped);
    }
  }
  return records;
}

/**
 * Throws the Phase 28 catalog code for a deny/queue gate.
 * @param {{ action: string, code?: string }} gate Gate result.
 * @returns {void}
 * @throws {ApiError}
 */
function throwIfKnowledgeNotReadable(gate) {
  if (gate.action === 'allow') {
    return;
  }
  throw ApiError.fromCode(gate.code === 'KNOWLEDGE_UPDATING' ? 'KNOWLEDGE_UPDATING' : 'KNOWLEDGE_UNAVAILABLE');
}

/**
 * explore_code — read lease, then buildContext or query fallback.
 * @param {object} args Tool args.
 * @param {object} scope Execution scope.
 * @param {object} deps Test seams.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function executeExploreCode(args, scope, deps) {
  throwIfAborted(scope.abortSignal);
  const assertReadable = deps.assertKnowledgeReadable ?? assertKnowledgeReadable;
  const gate = await assertReadable({ orgId: scope.orgId, projectId: scope.projectId }, deps);
  throwIfKnowledgeNotReadable(gate);

  const createAdapter = deps.createAdapter ?? createCodegraphAdapter;
  const adapter = createAdapter();
  const leaseResult = await adapter.acquireReadLease({
    orgId: scope.orgId,
    projectId: scope.projectId,
    workspacePath: scope.workspacePath,
  });
  if (!leaseResult.ok) {
    throw ApiError.fromCode(leaseResult.reason === 'writer' ? 'KNOWLEDGE_UPDATING' : 'KNOWLEDGE_UNAVAILABLE');
  }

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  try {
    throwIfAborted(scope.abortSignal);
    const result = await adapter.buildContext(leaseResult.lease.graph, {
      query,
      limit: SEARCH_GRAPH_MAX_RESULTS,
    });
    throwIfAborted(scope.abortSignal);
    return { evidenceRecords: mapExploreResult(scope, result, query), rejected: [] };
  } finally {
    leaseResult.lease.release();
  }
}

/**
 * search_documents — tenant-scoped Mongo FTS.
 * @param {object} args Tool args.
 * @param {object} scope Execution scope.
 * @param {object} deps Test seams.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function executeSearchDocuments(args, scope, deps) {
  throwIfAborted(scope.abortSignal);
  const search = deps.searchDocumentSections ?? searchDocumentSections;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const pathPrefix = typeof args.pathPrefix === 'string' ? args.pathPrefix.trim() : undefined;
  const hits = await search(
    { orgId: scope.orgId, projectId: scope.projectId, sourceVersionId: scope.sourceVersionId },
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
          evidenceId: nextEvidenceId(scope),
          kind: 'document',
          path,
          heading: typeof section.heading === 'string' ? section.heading : undefined,
          startLine: Number(section.startLine) || undefined,
          endLine: Number(section.endLine) || undefined,
          excerpt: capExcerpt(section.text),
          knowledgeVersionId: scope.knowledgeVersionId,
          sourceVersionId: scope.sourceVersionId,
          provenance: { toolName: 'search_documents', sectionId: section._id ? String(section._id) : undefined },
        },
      ];
    }),
    rejected: [],
  };
}

/**
 * list_documents — paginated document metadata.
 * @param {object} args Tool args.
 * @param {object} scope Execution scope.
 * @param {object} deps Test seams.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function executeListDocuments(args, scope, deps) {
  throwIfAborted(scope.abortSignal);
  const listFiles = deps.listDocumentFilesForVersion ?? listDocumentFilesForVersion;
  const rawPage = Number(args.pageSize);
  const limit = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(Math.floor(rawPage), LIST_DOCUMENTS_MAX_PAGE_SIZE) : LIST_DOCUMENTS_PAGE_SIZE;
  const files = await listFiles({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    afterPath: typeof args.cursor === 'string' ? args.cursor : undefined,
    limit,
  });
  return {
    evidenceRecords: (files ?? []).map((file) => ({
      evidenceId: nextEvidenceId(scope),
      kind: 'document',
      path: file.path,
      excerpt: '',
      knowledgeVersionId: scope.knowledgeVersionId,
      sourceVersionId: scope.sourceVersionId,
      excludedFromGraph: file.excludedFromGraph === true,
      provenance: { toolName: 'list_documents' },
    })),
    rejected: [],
  };
}

/**
 * Resolves a heading to a line range, or uses the requested lines.
 * @param {object} args Tool args.
 * @param {object} scope Execution scope.
 * @param {object} deps Test seams.
 * @returns {Promise<{ startLine: number, endLine: number, heading?: string } | { rejected: object[] }>}
 */
async function resolveDocumentSliceRange(args, scope, deps) {
  const heading = typeof args.heading === 'string' ? args.heading.trim() : '';
  if (!heading) {
    const startLine = Number(args.startLine);
    const endLine = Number(args.endLine);
    return { startLine, endLine };
  }
  const listSections = deps.listSectionsForPath ?? listSectionsForPath;
  const sections = await listSections({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    path: args.path,
  });
  const match = (sections ?? []).find((section) => section.heading === heading);
  if (!match) {
    return { rejected: [reject('not_found', 'Heading was not found in this document.')] };
  }
  return { startLine: match.startLine, endLine: match.endLine, heading };
}

/**
 * Shared GridFS slice → evidence record.
 * @param {object} args Path and lines.
 * @param {object} scope Execution scope.
 * @param {object} deps Test seams.
 * @param {'document' | 'code'} kind Evidence kind.
 * @param {string} toolName Provenance name.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function executeSliceRead(args, scope, deps, kind, toolName) {
  throwIfAborted(scope.abortSignal);
  const loadSlice = deps.loadSourceFileSlice ?? loadSourceFileSlice;
  try {
    const slice = await loadSlice(
      {
        orgId: scope.orgId,
        projectId: scope.projectId,
        path: args.path,
        startLine: args.startLine,
        endLine: args.endLine,
      },
      {
        findProject: deps.findProject,
        findKnowledgeVersion: deps.findKnowledgeVersion,
        findFile: deps.findFile,
        readBytes: deps.readBytes,
        caps: deps.caps,
      },
    );
    throwIfAborted(scope.abortSignal);
    return {
      evidenceRecords: [
        {
          evidenceId: nextEvidenceId(scope),
          kind,
          path: slice.path,
          startLine: slice.startLine,
          endLine: slice.endLine,
          heading: args.heading,
          excerpt: capExcerpt(slice.content, SEARCH_SNIPPET_MAX_CHARS * 4),
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
      return { evidenceRecords: [], rejected: [reject('not_found', 'Path was not found in the current version.')] };
    }
    throw error;
  }
}

/**
 * read_document_slice — docs only.
 * @param {object} args Tool args.
 * @param {object} scope Execution scope.
 * @param {object} deps Test seams.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function executeReadDocumentSlice(args, scope, deps) {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!isDocumentPath(path)) {
    return { evidenceRecords: [], rejected: [reject('wrong_kind', 'read_document_slice only accepts documentation paths.')] };
  }
  const range = await resolveDocumentSliceRange(args, scope, deps);
  if (range.rejected) {
    return { evidenceRecords: [], rejected: range.rejected };
  }
  return executeSliceRead({ ...args, ...range }, scope, deps, 'document', 'read_document_slice');
}

/**
 * read_file_slice — code/config only.
 * @param {object} args Tool args.
 * @param {object} scope Execution scope.
 * @param {object} deps Test seams.
 * @returns {Promise<{ evidenceRecords: object[], rejected: object[] }>}
 */
async function executeReadFileSlice(args, scope, deps) {
  const path = typeof args.path === 'string' ? args.path : '';
  if (isDocumentPath(path)) {
    return { evidenceRecords: [], rejected: [reject('wrong_kind', 'read_file_slice does not accept documentation paths.')] };
  }
  return executeSliceRead(args, scope, deps, 'code', 'read_file_slice');
}

/**
 * abstain — structured stop, no datastore.
 * @param {object} args Tool args.
 * @returns {{ evidenceRecords: object[], rejected: object[], stop: { reasonCode: string, message: string } }}
 */
function executeAbstain(args) {
  const reasonCode = ABSTAIN_REASON_CODES.includes(args.reasonCode) ? args.reasonCode : 'insufficient_scope';
  const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : 'Insufficient evidence.';
  return { evidenceRecords: [], rejected: [], stop: { reasonCode, message } };
}

/**
 * Maps surviving records through prepareModelInput and drops stubbed excerpts.
 * @param {object[]} records Raw evidence.
 * @param {object[]} rejected Existing rejects.
 * @param {object} budgetState Phase 48 budget snapshot.
 * @param {{ reasonCode: string, message: string }} [stop] Abstain payload.
 * @returns {object}
 */
function applyToolBudget(records, rejected, budgetState, stop) {
  if (stop) {
    return emptyToolResult(rejected, stop);
  }
  if (!budgetState?.modelArtifactRef) {
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
    modelArtifactRef: budgetState.modelArtifactRef,
    purpose: 'tool_result',
    segments,
    options: budgetState.options,
  });
  const droppedIds = new Set(
    (prepared.compactionActions ?? []).filter((action) => action.action === 'drop_tool_body' && action.segmentId).map((action) => action.segmentId),
  );
  /** @type {object[]} */
  const kept = [];
  const nextRejected = [...rejected];
  records.forEach((record, index) => {
    if (droppedIds.has(record.evidenceId)) {
      nextRejected.push(reject('oversized_result', 'Tool excerpt was dropped to fit the context budget.'));
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
    ...(stop ? { stop } : {}),
  };
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
 * @param {object} [deps] Test seams.
 * @returns {Promise<object>}
 * @throws {ApiError} TOOL_UNKNOWN or knowledge/catalog errors.
 */
export async function executeTool(input, deps = {}) {
  if (!TOOL_NAMES.includes(input?.name)) {
    throw ApiError.fromCode('TOOL_UNKNOWN');
  }
  throwIfAborted(input.scope?.abortSignal);

  const scoped = await buildToolExecutionScope(
    {
      orgId: input.scope.orgId,
      projectId: input.scope.projectId,
      knowledgeVersionId: input.scope.knowledgeVersionId,
      workspaceRoot: input.scope.workspaceRoot,
      correlationId: input.scope.correlationId,
      abortSignal: input.scope.abortSignal,
    },
    deps,
  );
  if (!scoped.ok) {
    return emptyToolResult(scoped.rejected);
  }

  const scope = scoped.scope;
  const args = input.args ?? {};
  let raw;
  if (input.name === 'explore_code') {
    raw = await executeExploreCode(args, scope, deps);
  } else if (input.name === 'search_documents') {
    raw = await executeSearchDocuments(args, scope, deps);
  } else if (input.name === 'list_documents') {
    raw = await executeListDocuments(args, scope, deps);
  } else if (input.name === 'read_document_slice') {
    raw = await executeReadDocumentSlice(args, scope, deps);
  } else if (input.name === 'read_file_slice') {
    raw = await executeReadFileSlice(args, scope, deps);
  } else {
    raw = executeAbstain(args);
  }
  return applyToolBudget(raw.evidenceRecords ?? [], raw.rejected ?? [], input.budgetState, raw.stop);
}
