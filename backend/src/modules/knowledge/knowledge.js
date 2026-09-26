/**
 * knowledge/knowledge.js — merged resource file.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { KnowledgeVersion } from '../../models/knowledgeVersion.model.js';
import { SourceFile } from '../../models/sourceFile.model.js';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { getCatalogEntry } from '../../platform/errorCatalog.js';
import { ApiError } from '../../platform/errors.js';
import { hasActiveProjectWriterLock } from '../../worker/projectJobLock.js';
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { recordAuditEvent } from '../access/index.js';
import { findProjectById } from '../masters/index.js';
import { resolveCodegraphDir, createCodegraphAdapter } from './codegraph.js';
import { listSectionsForVersion } from './documents.js';
import { runMaterializeDocsStage, runCodegraphUpdateStage } from './ingest.util.js';
import { SOURCE_FILE_STATE_STORED, resolveProjectWorkspacePath } from './sources.js';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// --- from knowledge/knowledgeVersion.repository.js ---
/**
 * Tenant-scoped KnowledgeVersion reads and writes.
 */
/**
 * Counts stored SourceFile rows excluded from the graph for a version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Tenant + version scope.
 * @returns {Promise<number>}
 */
export async function countExcludedFromGraphFiles(scope) {
  assertOrgId(scope.orgId);
  return SourceFile.countDocuments({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
    fileState: SOURCE_FILE_STATE_STORED,
    excludedFromGraph: true,
  }).exec();
}

/**
 * Finds an active KnowledgeVersion for a source version (most recent if several).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<object | null>}
 */
export async function findActiveKnowledgeVersionForSource(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(scope.sourceVersionId)) {
    return null;
  }
  return KnowledgeVersion.findOne({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ publishedAt: -1, _id: -1 })
    .lean()
    .exec();
}

/**
 * Loads an active KnowledgeVersion by id within a project.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   knowledgeVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<object | null>}
 */
export async function findKnowledgeVersionById(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(scope.knowledgeVersionId)) {
    return null;
  }
  return KnowledgeVersion.findOne({
    _id: scope.knowledgeVersionId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Inserts a KnowledgeVersion row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   graphIdentity: object,
 *   publishedHealth: string,
 *   excludedFileCount: number,
 *   publishedAt?: Date,
 *   createdBy?: string | null,
 * }} input Insert fields.
 * @returns {Promise<object>} Lean inserted document.
 */
export async function insertKnowledgeVersion(input) {
  assertOrgId(input.orgId);
  const doc = await KnowledgeVersion.create({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    graphIdentity: input.graphIdentity,
    publishedHealth: input.publishedHealth,
    excludedFileCount: input.excludedFileCount,
    publishedAt: input.publishedAt ?? new Date(),
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
    status: ROW_STATUS_ACTIVE,
  });
  return doc.toObject();
}

// --- from knowledge/knowledge.gate.js ---
/**
 * Internal Q&A / browse gate — allow, queue, or deny without taking a CodeGraph read lease.
 */
/**
 * Builds a gate result from a catalog code.
 * @param {'allow' | 'queue' | 'deny'} action Gate action.
 * @param {string} code Error / status code.
 * @param {string} [knowledgeVersionId] Current knowledge version when allowing.
 * @returns {{
 *   action: 'allow' | 'queue' | 'deny',
 *   code?: string,
 *   message?: string,
 *   knowledgeVersionId?: string,
 * }}
 */
function gateResult(action, code, knowledgeVersionId) {
  if (action === 'allow') {
    return { action: 'allow', knowledgeVersionId };
  }
  const entry = getCatalogEntry(code);
  return {
    action,
    code,
    message: entry?.message ?? 'Project knowledge is not available.',
  };
}

/**
 * Decides whether project knowledge may be read for chat/search/browse.
 * @param {{ orgId: string, projectId: string }} scope Tenant + project.
 * @param {{
 *   findProject?: typeof findProjectById,
 *   hasWriterLock?: typeof hasActiveProjectWriterLock,
 * }} [deps] Test seams.
 * @returns {Promise<{
 *   action: 'allow' | 'queue' | 'deny',
 *   code?: string,
 *   message?: string,
 *   knowledgeVersionId?: string,
 * }>}
 */
export async function assertKnowledgeReadable(scope, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const hasWriterLock = deps.hasWriterLock ?? hasActiveProjectWriterLock;

  const project = await findProject(scope.orgId, scope.projectId);
  if (!project) {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  if (project.lifecycleStatus === 'archived') {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  if (project.knowledgeHealth === 'failed') {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  const knowledgeVersionId = project.currentKnowledgeVersionId ? String(project.currentKnowledgeVersionId) : null;
  if (!knowledgeVersionId) {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  if (project.knowledgeHealth === 'updating') {
    return gateResult('queue', 'KNOWLEDGE_UPDATING');
  }

  const writerActive = await hasWriterLock({
    orgId: scope.orgId,
    projectId: scope.projectId,
  });
  if (writerActive) {
    return gateResult('queue', 'KNOWLEDGE_UPDATING');
  }

  const healthOk = project.knowledgeHealth === 'ready' || project.knowledgeHealth === 'partially_available';
  const lifecycleOk = project.lifecycleStatus === 'knowledge_ready' || project.lifecycleStatus === 'partially_available';
  if (healthOk && lifecycleOk) {
    return gateResult('allow', undefined, knowledgeVersionId);
  }

  return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
}

// --- from knowledge/knowledge.publish.js ---
/**
 * S5 knowledge publish — insert KnowledgeVersion and audit completion.
 */
/** Relative graph directory name stored on KnowledgeVersion (never an absolute path). */
export const KNOWLEDGE_GRAPH_DIR_NAME = '.codegraph';

/**
 * Builds a persistable graphIdentity without absolute filesystem paths.
 * @param {object} identity S4 validation identity.
 * @returns {object}
 */
export function sanitizeGraphIdentityForPublish(identity) {
  return {
    graphHash: identity.graphHash ?? null,
    indexedAt: String(identity.indexedAt),
    sourceVersionId: String(identity.sourceVersionId),
    indexedFileCount: Math.max(0, Math.floor(Number(identity.indexedFileCount) || 0)),
    skippedFileCount: Math.max(0, Math.floor(Number(identity.skippedFileCount) || 0)),
    mode: identity.mode === 'sync' ? 'sync' : 'indexAll',
    graphDir: KNOWLEDGE_GRAPH_DIR_NAME,
  };
}

/**
 * Resolves published health from exclusion count.
 * @param {number} excludedFileCount Excluded stored files.
 * @returns {'ready' | 'partially_available'}
 */
export function resolvePublishedHealth(excludedFileCount) {
  return excludedFileCount > 0 ? 'partially_available' : 'ready';
}

/**
 * Publishes a KnowledgeVersion for the job's source version.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   graphIdentity: object,
 *   correlationId?: string | null,
 *   log?: { error?: Function },
 * }} input Publish inputs.
 * @returns {Promise<{
 *   knowledgeVersionId: string,
 *   publishedHealth: 'ready' | 'partially_available',
 *   excludedFileCount: number,
 *   reused: boolean,
 *   outcome: 'completed' | 'completed_with_warnings',
 * }>}
 */
export async function publishKnowledgeVersion(input) {
  if (!input.graphIdentity || typeof input.graphIdentity !== 'object') {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_MISSING_GRAPH_IDENTITY',
      message: 'Knowledge publish requires a validated graph identity from the code index stage.',
    });
  }

  const excludedFileCount = await countExcludedFromGraphFiles({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
  });
  const publishedHealth = resolvePublishedHealth(excludedFileCount);
  const graphIdentity = sanitizeGraphIdentityForPublish(input.graphIdentity);

  const existing = await findActiveKnowledgeVersionForSource({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
  });
  if (existing && existing.graphIdentity?.graphHash === graphIdentity.graphHash && existing.publishedHealth === publishedHealth) {
    return {
      knowledgeVersionId: String(existing._id),
      publishedHealth,
      excludedFileCount,
      reused: true,
      outcome: excludedFileCount > 0 ? 'completed_with_warnings' : 'completed',
    };
  }

  const created = await insertKnowledgeVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    graphIdentity,
    publishedHealth,
    excludedFileCount,
    createdBy: null,
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: null,
      action: 'knowledge.completed',
      resourceType: 'knowledge',
      resourceId: String(created._id),
      result: 'success',
      correlationId: input.correlationId ?? null,
      context: {
        projectId: String(input.projectId),
        sourceVersionId: String(input.sourceVersionId),
        knowledgeVersionId: String(created._id),
        publishedHealth,
        excludedFileCount,
      },
    },
    { log: input.log },
  );

  return {
    knowledgeVersionId: String(created._id),
    publishedHealth,
    excludedFileCount,
    reused: false,
    outcome: excludedFileCount > 0 ? 'completed_with_warnings' : 'completed',
  };
}

// --- from knowledge/knowledge.recovery.js ---
/**
 * Same-job S4 recovery — rematerialize this source version and full indexAll.
 */
/** Bounded rematerialize + indexAll attempts before knowledge fails permanently. */
export const KNOWLEDGE_RECOVERY_MAX_ATTEMPTS = 3;

/**
 * Deletes the on-disk `.codegraph` directory so the next S4 takes indexAll.
 * @param {string} workspacePath Absolute project workspace.
 * @returns {Promise<void>}
 */
export async function wipeCodegraphIndex(workspacePath) {
  const graphDir = resolveCodegraphDir(workspacePath);
  await fs.rm(graphDir, { recursive: true, force: true });
  // Ensure parent still exists for the next indexAll.
  await fs.mkdir(path.dirname(graphDir), { recursive: true });
}

/**
 * True when a thrown value is a temporary CodeGraph failure eligible for recovery.
 * @param {unknown} err Thrown value.
 * @returns {boolean}
 */
export function isRecoverableCodegraphFailure(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const failureClass = /** @type {{ failureClass?: unknown }} */ (err).failureClass;
  const code = String(/** @type {{ code?: unknown }} */ (err).code ?? '');
  if (failureClass !== 'temporary') {
    return false;
  }
  return code.startsWith('CODEGRAPH_') || code === 'INGEST_STAGE_TIMEOUT' || code === 'WORKSPACE_IO_ERROR';
}

/**
 * Runs S4 with same-job recovery: rematerialize this version, wipe index, retry indexAll.
 * @param {object} ctx IngestStageContext.
 * @param {{
 *   runS3?: typeof runMaterializeDocsStage,
 *   runS4?: typeof runCodegraphUpdateStage,
 *   wipeIndex?: typeof wipeCodegraphIndex,
 *   maxAttempts?: number,
 * }} [deps] Test seams.
 * @returns {Promise<object>} S4 stage result.
 */
export async function runCodegraphUpdateWithRecovery(ctx, deps = {}) {
  const runS3 = deps.runS3 ?? runMaterializeDocsStage;
  const runS4 = deps.runS4 ?? runCodegraphUpdateStage;
  const wipeIndex = deps.wipeIndex ?? wipeCodegraphIndex;
  const maxAttempts = deps.maxAttempts ?? KNOWLEDGE_RECOVERY_MAX_ATTEMPTS;

  try {
    return await runS4(ctx);
  } catch (err) {
    if (!isRecoverableCodegraphFailure(err)) {
      throw err;
    }

    const priorAttempts = Number(ctx.checkpoint?.cursor?.recoveryAttempts ?? 0);
    if (priorAttempts >= maxAttempts) {
      throw createJobFailureError({
        failureClass: 'permanent',
        code: 'CODEGRAPH_RECOVERY_EXHAUSTED',
        message: 'Code index recovery retries were exhausted.',
      });
    }

    const nextAttempts = priorAttempts + 1;
    const priorCursor = ctx.checkpoint?.cursor && typeof ctx.checkpoint.cursor === 'object' ? { ...ctx.checkpoint.cursor } : {};
    priorCursor.recoveryAttempts = nextAttempts;

    const lastCompleted = ctx.checkpoint?.lastCompletedStage ?? null;
    if (lastCompleted) {
      await ctx.saveCheckpoint({
        lastCompletedStage: lastCompleted,
        cursor: priorCursor,
        currentStage: 'codegraph_update',
      });
      ctx.checkpoint = {
        lastCompletedStage: lastCompleted,
        cursor: priorCursor,
      };
    }

    ctx.logger?.warn?.({ recoveryAttempts: nextAttempts, maxAttempts }, 'codegraph recovery rematerialize starting');

    await runS3(ctx);

    const workspacePath = typeof ctx.carry?.workspacePath === 'string' ? ctx.carry.workspacePath : null;
    if (workspacePath) {
      await wipeIndex(workspacePath);
    }

    // Clear changedPaths so S4 prefers full index after wipe.
    if (ctx.carry) {
      delete ctx.carry.changedPaths;
    }

    return runS4(ctx);
  }
}

// --- from knowledge/knowledge.browse.service.js ---
/**
 * Knowledge browse orchestration: gate → read lease → bounded queries.
 */
/** Default page size for list browse routes. */
export const KNOWLEDGE_BROWSE_PAGE_SIZE = 50;

/** Hard cap on browse `limit`. */
export const KNOWLEDGE_BROWSE_MAX_LIMIT = 100;

/** Minimum `q` length for symbol lookup. */
export const KNOWLEDGE_SYMBOL_QUERY_MIN_LEN = 2;

/** Cap on extractive summary text. */
export const KNOWLEDGE_SUMMARY_MAX_CHARS = 4000;

/**
 * Builds the shared browse envelope.
 * @param {'ready' | 'updating' | 'unavailable'} state Gate wrapper state.
 * @param {{
 *   knowledgeVersionId?: string | null,
 *   knowledgeHealth?: string | null,
 * }} [base] Shared fields.
 * @returns {object}
 */
export function emptyBrowseEnvelope(state, base = {}) {
  return {
    state,
    knowledgeVersionId: base.knowledgeVersionId ?? null,
    knowledgeHealth: base.knowledgeHealth ?? null,
    facets: [],
    items: [],
    cursor: null,
    summary: '',
    capabilities: [],
    title: '',
    dimensions: {},
    partialKnowledge: { excludedFromGraphCount: 0 },
  };
}

/**
 * Facets that have data. Empty categories are omitted (explorer §71).
 * @param {{
 *   hasSummary?: boolean,
 *   hasWorkflows?: boolean,
 *   hasApis?: boolean,
 *   hasSymbols?: boolean,
 *   hasDocumentation?: boolean,
 * }} flags Availability flags.
 * @returns {Array<{ key: string, available: true }>}
 */
export function mapBrowseFacets(flags) {
  /** @type {Array<{ key: string, available: true }>} */
  const facets = [];
  if (flags.hasSummary) {
    facets.push({ key: 'summary', available: true });
  }
  if (flags.hasWorkflows) {
    facets.push({ key: 'workflows', available: true });
  }
  if (flags.hasApis) {
    facets.push({ key: 'apis', available: true });
  }
  if (flags.hasSymbols) {
    facets.push({ key: 'symbols', available: true });
  }
  if (flags.hasDocumentation) {
    facets.push({ key: 'documentation', available: true });
  }
  return facets;
}

/**
 * Maps a CodeGraph symbol/search hit to a browse item.
 * @param {object} raw Library node or search result.
 * @returns {object | null}
 */
export function mapSymbolItem(raw) {
  const node = raw?.node && typeof raw.node === 'object' ? raw.node : raw;
  if (!node || typeof node !== 'object') {
    return null;
  }
  const name = typeof node.name === 'string' ? node.name : null;
  const path = typeof node.filePath === 'string' ? node.filePath : null;
  if (!name || !path) {
    return null;
  }
  const startLine = Number(node.startLine) || null;
  const endLine = Number(node.endLine) || startLine;
  return {
    id: typeof node.id === 'string' ? node.id : `${path}:${name}:${startLine ?? 0}`,
    name,
    kind: typeof node.kind === 'string' ? node.kind : 'symbol',
    path,
    line: startLine,
    sourceRef: { path, startLine, endLine },
  };
}

/**
 * Maps a routing-manifest entry or route node to an API item.
 * @param {object} raw Library row.
 * @param {number} index Fallback id salt.
 * @returns {object | null}
 */
export function mapApiItem(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.url === 'string') {
    return {
      id: `api:${raw.url}:${raw.handler ?? index}`,
      title: raw.url,
      description: typeof raw.handler === 'string' ? raw.handler : undefined,
      sourceRefs: raw.handlerFile ? [{ path: raw.handlerFile, startLine: Number(raw.handlerLine) || null, kind: 'code' }] : [],
    };
  }
  const path = typeof raw.filePath === 'string' ? raw.filePath : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!path || !name) {
    return null;
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : `api:${path}:${name}`,
    title: name,
    sourceRefs: [{ path, startLine: Number(raw.startLine) || null, kind: 'code' }],
  };
}

/**
 * Caps extractive summary text.
 * @param {string} text Raw joined text.
 * @returns {string}
 */
export function capSummaryText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  if (text.length <= KNOWLEDGE_SUMMARY_MAX_CHARS) {
    return text;
  }
  return text.slice(0, KNOWLEDGE_SUMMARY_MAX_CHARS);
}

/**
 * Builds an extractive summary from docs + graph metadata (no LLM).
 * @param {{
 *   projectName?: string,
 *   stats?: { fileCount?: number, nodeCount?: number } | null,
 *   frameworks?: string[],
 *   sections?: Array<{ heading?: string | null, text?: string, path?: string }>,
 * }} input Source fragments.
 * @returns {string}
 */
export function buildExtractiveSummary(input) {
  const parts = [];
  if (input.projectName) {
    parts.push(input.projectName);
  }
  const fileCount = Number(input.stats?.fileCount);
  const nodeCount = Number(input.stats?.nodeCount);
  if (Number.isFinite(fileCount) && fileCount > 0) {
    parts.push(`${fileCount} indexed files`);
  }
  if (Number.isFinite(nodeCount) && nodeCount > 0) {
    parts.push(`${nodeCount} graph nodes`);
  }
  if (Array.isArray(input.frameworks) && input.frameworks.length > 0) {
    parts.push(`Detected: ${input.frameworks.join(', ')}`);
  }
  for (const section of input.sections ?? []) {
    const heading = typeof section.heading === 'string' ? section.heading.trim() : '';
    const text = typeof section.text === 'string' ? section.text.trim() : '';
    if (heading) {
      parts.push(heading);
    }
    if (text) {
      parts.push(text);
    }
  }
  return capSummaryText(parts.filter(Boolean).join('\n\n'));
}

/**
 * Honest health dimensions — no fabricated documentation score.
 * @param {{
 *   hasSource: boolean,
 *   publishedHealth?: string | null,
 *   excludedFromGraphCount: number,
 * }} input Facts.
 * @returns {object}
 */
export function mapHealthDimensions(input) {
  return {
    sourceCode: {
      state: input.hasSource ? 'present' : 'absent',
      detail: null,
    },
    publishedHealth: {
      state: input.publishedHealth || 'none',
      detail: null,
    },
    exclusions: {
      state: input.excludedFromGraphCount > 0 ? 'partial' : 'none',
      detail: input.excludedFromGraphCount > 0 ? `${input.excludedFromGraphCount} files are not in the code map` : null,
    },
  };
}

/**
 * Clamps a browse page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampBrowseLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return KNOWLEDGE_BROWSE_PAGE_SIZE;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return KNOWLEDGE_BROWSE_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), KNOWLEDGE_BROWSE_MAX_LIMIT);
}

/**
 * Loads the active project or throws 404.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {typeof findProjectById} findProject Finder.
 * @returns {Promise<object>}
 */
async function loadActiveProject(orgId, projectId, findProject) {
  const project = await findProject(orgId, projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }
  return project;
}

/**
 * Maps a gate action to the browse wrapper state.
 * @param {'allow' | 'queue' | 'deny'} action Gate action.
 * @returns {'ready' | 'updating' | 'unavailable'}
 */
function stateFromGate(action) {
  if (action === 'allow') {
    return 'ready';
  }
  if (action === 'queue') {
    return 'updating';
  }
  return 'unavailable';
}

/**
 * Runs a browse kind after the gate allows.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   kind: 'index' | 'summary' | 'workflows' | 'apis' | 'symbols' | 'health',
 *   workspaceRoot: string,
 *   query?: { q?: string, cursor?: string, limit?: unknown },
 *   project: object,
 *   knowledgeVersionId: string,
 * }} input Allowed-path inputs.
 * @param {object} deps Injected deps.
 * @returns {Promise<object>}
 */
async function loadReadyBrowse(input, deps) {
  const knowledgeVersion = await deps.findKnowledgeVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    knowledgeVersionId: input.knowledgeVersionId,
  });
  const sourceVersionId = knowledgeVersion?.sourceVersionId ? String(knowledgeVersion.sourceVersionId) : null;
  const excludedFromGraphCount = Number(knowledgeVersion?.excludedFileCount ?? 0);
  const sections = sourceVersionId
    ? await deps.listSections({
        orgId: input.orgId,
        projectId: input.projectId,
        sourceVersionId,
      })
    : [];

  if (input.kind === 'health') {
    return {
      state: /** @type {'ready'} */ ('ready'),
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      lifecycleStatus: input.project.lifecycleStatus,
      dimensions: mapHealthDimensions({
        hasSource: Boolean(sourceVersionId),
        publishedHealth: knowledgeVersion?.publishedHealth ?? input.project.knowledgeHealth,
        excludedFromGraphCount,
      }),
      partialKnowledge: { excludedFromGraphCount },
    };
  }

  const workspacePath = resolveProjectWorkspacePath(input.workspaceRoot, input.orgId, input.projectId);
  const adapter = deps.createAdapter();
  const leased = await adapter.acquireReadLease({
    orgId: input.orgId,
    projectId: input.projectId,
    workspacePath,
  });

  if (!leased.ok && leased.reason === 'writer') {
    return {
      ...emptyBrowseEnvelope('updating', {
        knowledgeVersionId: input.knowledgeVersionId,
        knowledgeHealth: input.project.knowledgeHealth,
      }),
      lifecycleStatus: input.project.lifecycleStatus,
      partialKnowledge: { excludedFromGraphCount },
    };
  }

  if (!leased.ok) {
    const summary = buildExtractiveSummary({
      projectName: input.project.name,
      stats: null,
      frameworks: [],
      sections,
    });
    const base = {
      state: /** @type {'ready'} */ ('ready'),
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      partialKnowledge: { excludedFromGraphCount },
    };
    if (input.kind === 'summary') {
      return { ...base, title: input.project.name, summary, capabilities: [] };
    }
    if (input.kind === 'index') {
      return {
        ...base,
        facets: mapBrowseFacets({
          hasSummary: summary.length > 0,
          hasDocumentation: sections.length > 0,
        }),
        cursor: null,
      };
    }
    return { ...base, items: [], cursor: null };
  }

  try {
    if (leased.lease.expired) {
      return {
        ...emptyBrowseEnvelope('unavailable', {
          knowledgeVersionId: input.knowledgeVersionId,
          knowledgeHealth: input.project.knowledgeHealth,
        }),
        lifecycleStatus: input.project.lifecycleStatus,
        partialKnowledge: { excludedFromGraphCount },
      };
    }

    const graph = leased.lease.graph;
    const limit = clampBrowseLimit(input.query?.limit);
    const stats = adapter.queryStats(graph);
    const frameworks = typeof graph.getDetectedFrameworks === 'function' ? graph.getDetectedFrameworks() : [];
    const symbolKindCount = Number(stats?.nodesByKind?.function ?? 0) + Number(stats?.nodesByKind?.method ?? 0) + Number(stats?.nodeCount ?? 0);
    const apiHits = input.kind === 'index' || input.kind === 'apis' ? adapter.queryApis(graph, limit) : [];
    const workflowHits = input.kind === 'index' || input.kind === 'workflows' ? adapter.queryWorkflows(graph, limit) : [];
    const symbolHits = input.kind === 'symbols' ? adapter.querySymbols(graph, input.query?.q ?? '', limit) : [];
    const symbols = symbolHits.map(mapSymbolItem).filter(Boolean);
    const apis = apiHits.map((row, index) => mapApiItem(row, index)).filter(Boolean);
    const workflows = workflowHits.map((row, index) => mapApiItem(row, index)).filter(Boolean);
    const summary = buildExtractiveSummary({
      projectName: input.project.name,
      stats,
      frameworks: Array.isArray(frameworks) ? frameworks : [],
      sections,
    });

    if (leased.lease.expired) {
      return {
        ...emptyBrowseEnvelope('unavailable', {
          knowledgeVersionId: input.knowledgeVersionId,
          knowledgeHealth: input.project.knowledgeHealth,
        }),
        lifecycleStatus: input.project.lifecycleStatus,
        partialKnowledge: { excludedFromGraphCount },
      };
    }

    const base = {
      state: /** @type {'ready'} */ ('ready'),
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      partialKnowledge: { excludedFromGraphCount },
    };

    if (input.kind === 'index') {
      return {
        ...base,
        facets: mapBrowseFacets({
          hasSummary: summary.length > 0,
          hasWorkflows: workflows.length > 0,
          hasApis: apis.length > 0,
          hasSymbols: symbolKindCount > 0,
          hasDocumentation: sections.length > 0,
        }),
        cursor: null,
      };
    }
    if (input.kind === 'summary') {
      return {
        ...base,
        title: input.project.name,
        summary,
        capabilities: [],
      };
    }
    if (input.kind === 'workflows') {
      return { ...base, items: workflows, cursor: null };
    }
    if (input.kind === 'apis') {
      return { ...base, items: apis, cursor: null };
    }
    if (input.kind === 'symbols') {
      return { ...base, items: symbols, cursor: null };
    }
    return {
      ...base,
      lifecycleStatus: input.project.lifecycleStatus,
      dimensions: mapHealthDimensions({
        hasSource: Boolean(sourceVersionId),
        publishedHealth: knowledgeVersion?.publishedHealth ?? input.project.knowledgeHealth,
        excludedFromGraphCount,
      }),
    };
  } finally {
    leased.lease.release();
  }
}

/**
 * Loads a browse payload for the current knowledge version.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   kind: 'index' | 'summary' | 'workflows' | 'apis' | 'symbols' | 'health',
 *   workspaceRoot: string,
 *   query?: { q?: string, cursor?: string, limit?: unknown },
 * }} input Browse request.
 * @param {{
 *   findProject?: typeof findProjectById,
 *   assertReadable?: typeof assertKnowledgeReadable,
 *   findKnowledgeVersion?: typeof findKnowledgeVersionById,
 *   listSections?: typeof listSectionsForVersion,
 *   createAdapter?: () => object,
 * }} [deps] Test seams.
 * @returns {Promise<object>}
 */
export async function loadKnowledgeBrowse(input, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const assertReadable = deps.assertReadable ?? assertKnowledgeReadable;
  const findKnowledgeVersion = deps.findKnowledgeVersion ?? findKnowledgeVersionById;
  const listSections = deps.listSections ?? listSectionsForVersion;
  const createAdapter = deps.createAdapter ?? createCodegraphAdapter;

  const project = await loadActiveProject(input.orgId, input.projectId, findProject);
  const gate = await assertReadable({ orgId: input.orgId, projectId: input.projectId });
  const state = stateFromGate(gate.action);
  if (state !== 'ready') {
    return {
      ...emptyBrowseEnvelope(state, {
        knowledgeVersionId: gate.knowledgeVersionId
          ? String(gate.knowledgeVersionId)
          : project.currentKnowledgeVersionId
            ? String(project.currentKnowledgeVersionId)
            : null,
        knowledgeHealth: project.knowledgeHealth,
      }),
      lifecycleStatus: project.lifecycleStatus,
    };
  }

  return loadReadyBrowse(
    {
      ...input,
      project,
      knowledgeVersionId: String(gate.knowledgeVersionId),
    },
    { findKnowledgeVersion, listSections, createAdapter },
  );
}

// --- from knowledge/knowledge.routes.js ---
/**
 * Knowledge browse HTTP routes under `/api/v1/projects/:projectId/knowledge`.
 */
const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});

const symbolsQuerySchema = listQuerySchema.extend({
  q: z.string().min(KNOWLEDGE_SYMBOL_QUERY_MIN_LEN),
});

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

const browsePreHandler = requireProjectPermission(['knowledge.browse', 'knowledge.view'], {
  mode: 'any',
});

/**
 * Shared GET handler after ACL.
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {'index' | 'summary' | 'workflows' | 'apis' | 'symbols' | 'health'} kind Browse kind.
 * @param {object} query Parsed query.
 * @returns {Promise<object>}
 */
async function handleBrowse(request, kind, query) {
  return loadKnowledgeBrowse({
    orgId: request.projectScope.orgId,
    projectId: request.projectScope.projectId,
    kind,
    workspaceRoot: request.server.config.workspace.root,
    query,
  });
}

/**
 * Registers knowledge browse routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function knowledgeBrowseRoutes(app) {
  const config = { routeAccess: 'authenticated' };

  app.get('/projects/:projectId/knowledge/summary', { config, preHandler: browsePreHandler }, async (request) =>
    handleBrowse(request, 'summary', {}),
  );

  app.get('/projects/:projectId/knowledge/workflows', { config, preHandler: browsePreHandler }, async (request) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    return handleBrowse(request, 'workflows', parsed.data);
  });

  app.get('/projects/:projectId/knowledge/apis', { config, preHandler: browsePreHandler }, async (request) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    return handleBrowse(request, 'apis', parsed.data);
  });

  app.get('/projects/:projectId/knowledge/symbols', { config, preHandler: browsePreHandler }, async (request) => {
    const parsed = symbolsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    return handleBrowse(request, 'symbols', parsed.data);
  });

  app.get('/projects/:projectId/knowledge/health', { config, preHandler: browsePreHandler }, async (request) => handleBrowse(request, 'health', {}));

  app.get('/projects/:projectId/knowledge', { config, preHandler: browsePreHandler }, async (request) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    return handleBrowse(request, 'index', parsed.data);
  });
}

export { KnowledgeVersion } from '../../models/knowledgeVersion.model.js';
export const KNOWLEDGE_MODELS = Object.freeze([KnowledgeVersion]);
