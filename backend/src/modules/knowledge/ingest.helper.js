/**
 * knowledge/ingest.helper.js — merged resource file.
 */
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { renderJobEventMessage, findProjectById, transitionLifecycle } from '../masters/index.js';
import {
  countSourceFilesForVersion,
  listSourceFilesOrdered,
  markSourceVersionFailed,
  SOURCE_FILE_STATE_CORRUPT,
  SOURCE_FILE_STATE_MISSING,
  SOURCE_FILE_STATE_STORED,
  findSourceGridFsFileById,
  markOrphanGridFsObjects,
  updateSourceFileState,
  updateSourceFileExclusion,
} from './ingest.js';
import { publishKnowledgeVersion } from './knowledge.js';
import { assertKnownExclusionRulesetId, isUnsafeArchivePath, normalizeArchivePath, evaluateUploadEntry } from './uploads.js';

// --- from ingest/ingest.counters.js ---
/**
 * Ingest progress counters — honest counts only; no estimated percentages.
 */

/** Files reconciled per batch before a progress flush. */
export const INGEST_FILE_BATCH_SIZE = 250;

/** Minimum interval between counter writes to the job row. */
export const INGEST_PROGRESS_FLUSH_MS = 2000;

/**
 * @typedef {{
 *   filesTotal: number,
 *   filesProcessed: number,
 *   filesFailed: number,
 *   filesExcluded: number,
 *   bytesProcessed: number,
 *   excludedByReason: Record<string, number>,
 * }} IngestCounters
 */

/**
 * Creates a zeroed counter bag.
 * @returns {IngestCounters}
 */
export function createIngestCounters() {
  return {
    filesTotal: 0,
    filesProcessed: 0,
    filesFailed: 0,
    filesExcluded: 0,
    bytesProcessed: 0,
    excludedByReason: {},
  };
}

/**
 * Maps ingest counters onto the Job.progressCounters schema fields.
 * @param {IngestCounters} counters Domain counters.
 * @returns {{
 *   itemsProcessed: number,
 *   itemsFailed: number,
 *   warningCount: number,
 *   excludedCount: number,
 * }}
 */
export function toJobProgressCounters(counters) {
  return {
    itemsProcessed: counters.filesProcessed,
    itemsFailed: counters.filesFailed,
    warningCount: counters.filesFailed > 0 ? 1 : 0,
    excludedCount: counters.filesExcluded,
  };
}

/**
 * True when the job finished with some failed or graph-excluded files but otherwise succeeded.
 * @param {IngestCounters} counters Domain counters.
 * @param {boolean} otherwiseCompleted Pipeline completed past implemented stages.
 * @returns {boolean}
 */
export function derivePartialSuccess(counters, otherwiseCompleted) {
  return otherwiseCompleted === true && (counters.filesFailed > 0 || counters.filesExcluded > 0);
}

/**
 * Creates a throttled progress flusher bound to saveProgress.
 * @param {{
 *   counters: IngestCounters,
 *   saveProgress: (payload: object) => Promise<void>,
 *   getCurrentStage?: () => string | null,
 *   now?: () => number,
 *   flushIntervalMs?: number,
 * }} options Flush options.
 * @returns {{
 *   noteFileProcessed: () => void,
 *   maybeFlush: (force?: boolean) => Promise<void>,
 *   flushNow: () => Promise<void>,
 * }}
 */
export function createProgressFlusher(options) {
  const flushIntervalMs = options.flushIntervalMs ?? INGEST_PROGRESS_FLUSH_MS;
  const now = options.now ?? Date.now;
  let lastFlushAt = 0;
  let sinceFlush = 0;

  /**
   * Increments the batch counter used for flush batching.
   */
  function noteFileProcessed() {
    sinceFlush += 1;
  }

  /**
   * Writes counters when forced, at stage boundaries, or after interval/batch.
   * @param {boolean} [force] Always write.
   * @returns {Promise<void>}
   */
  async function maybeFlush(force = false) {
    const elapsed = now() - lastFlushAt;
    const batchReady = sinceFlush >= INGEST_FILE_BATCH_SIZE;
    const intervalReady = elapsed >= flushIntervalMs && sinceFlush > 0;
    if (!force && !batchReady && !intervalReady) {
      return;
    }
    await flushNow();
  }

  /**
   * Always writes counters and resets the batch window.
   * @returns {Promise<void>}
   */
  async function flushNow() {
    const payload = {
      ...toJobProgressCounters(options.counters),
      partialSuccess: options.counters.filesFailed > 0,
    };
    if (typeof options.getCurrentStage === 'function') {
      payload.currentStage = options.getCurrentStage();
    }
    await options.saveProgress(payload);
    lastFlushAt = now();
    sinceFlush = 0;
  }

  return { noteFileProcessed, maybeFlush, flushNow };
}

// --- from ingest/ingest.events.js ---
/**
 * User-readable JobEvent message builders for ingest stages (backend §34).
 */
/**
 * Builds the S0 "source received" event.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildSourceReceivedEvent() {
  return {
    eventCode: 'source.received',
    severity: 'info',
    message: renderJobEventMessage('source.received'),
    data: {},
  };
}

/**
 * Builds the S0 "source validated" event with an honest file count.
 * @param {number} filesTotal Accepted file count after validation.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildSourceValidatedEvent(filesTotal) {
  const count = Math.max(0, Math.floor(filesTotal));
  return {
    eventCode: 'source.validated',
    severity: 'info',
    message: renderJobEventMessage('source.validated', { filesTotal: count }),
    data: { filesTotal: count },
  };
}

/**
 * Builds the S1 "project files identified" event.
 * @param {{ filesProcessed: number, filesFailed: number }} counts Honest counts.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildFilesIdentifiedEvent(counts) {
  const filesProcessed = Math.max(0, Math.floor(counts.filesProcessed));
  const filesFailed = Math.max(0, Math.floor(counts.filesFailed));
  return {
    eventCode: 'files.identified',
    severity: filesFailed > 0 ? 'warning' : 'info',
    message: renderJobEventMessage('files.identified', { filesProcessed, filesFailed }),
    data: { filesProcessed, filesFailed },
  };
}

/**
 * Builds the S2 "exclusions applied" event.
 * @param {{ excludedPaths: number, filesProcessed: number, filesFailed: number }} counts Counts.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildExclusionsAppliedEvent(counts) {
  const excludedPaths = Math.max(0, Math.floor(counts.excludedPaths));
  return {
    eventCode: 'source.exclusions_applied',
    severity: 'info',
    message: renderJobEventMessage('source.exclusions_applied', {
      excludedPaths,
    }),
    data: {
      excludedPaths,
      filesProcessed: Math.max(0, Math.floor(counts.filesProcessed)),
      filesFailed: Math.max(0, Math.floor(counts.filesFailed)),
    },
  };
}

/**
 * Builds the S3 "project files materialized" event.
 * @param {{ pathsWritten: number }} counts Honest path count written this run.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildWorkspaceMaterializedEvent(counts) {
  const pathsWritten = Math.max(0, Math.floor(counts.pathsWritten));
  return {
    eventCode: 'workspace.materialized',
    severity: 'info',
    message: renderJobEventMessage('workspace.materialized', { pathsWritten }),
    data: { pathsWritten },
  };
}

/**
 * Builds the S3 "documentation identified" event.
 * @param {{
 *   documentationFiles: number,
 *   documentationSections: number,
 *   failedDocuments?: number,
 * }} counts Honest documentation counts.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildDocumentationIdentifiedEvent(counts) {
  const documentationFiles = Math.max(0, Math.floor(counts.documentationFiles));
  const documentationSections = Math.max(0, Math.floor(counts.documentationSections));
  const failedDocuments = Math.max(0, Math.floor(counts.failedDocuments ?? 0));
  return {
    eventCode: 'docs.identified',
    severity: failedDocuments > 0 ? 'warning' : 'info',
    message: renderJobEventMessage('docs.identified', {
      documentationFiles,
      documentationSections,
      failedDocuments,
    }),
    data: {
      documentationFiles,
      documentationSections,
      failedDocuments,
    },
  };
}

/**
 * Builds the S4 "project structure analyzed" event.
 * @param {{ indexedFiles: number, skippedFiles?: number }} counts Honest index counts.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildProjectStructureAnalyzedEvent(counts) {
  const indexedFiles = Math.max(0, Math.floor(counts.indexedFiles));
  const skippedFiles = Math.max(0, Math.floor(counts.skippedFiles ?? 0));
  return {
    eventCode: 'structure.analyzed',
    severity: 'info',
    message: renderJobEventMessage('structure.analyzed', { indexedFiles, skippedFiles }),
    data: { indexedFiles, skippedFiles },
  };
}

/**
 * Builds the S4 "code relationships analyzed" event.
 * @param {{ indexedFiles: number }} counts Honest index counts.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildCodeRelationshipsAnalyzedEvent(counts) {
  const indexedFiles = Math.max(0, Math.floor(counts.indexedFiles));
  return {
    eventCode: 'relationships.analyzed',
    severity: 'info',
    message: renderJobEventMessage('relationships.analyzed', { indexedFiles }),
    data: { indexedFiles },
  };
}

/**
 * Builds the S5 "project knowledge updated" event.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildKnowledgeUpdatedEvent() {
  return {
    eventCode: 'knowledge.updated',
    severity: 'info',
    message: renderJobEventMessage('knowledge.updated'),
    data: {},
  };
}

/**
 * Builds the S5 "knowledge validated" event.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildKnowledgeValidatedEvent() {
  return {
    eventCode: 'knowledge.validated',
    severity: 'info',
    message: renderJobEventMessage('knowledge.validated'),
    data: {},
  };
}

/**
 * Builds the S6 "Ready" event.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildKnowledgeReadyEvent() {
  return {
    eventCode: 'knowledge.ready',
    severity: 'info',
    message: renderJobEventMessage('knowledge.ready'),
    data: {},
  };
}

// --- from ingest/stages/s0ValidateUpload.js ---
/**
 * S0 validate_upload — re-validate SourceVersion metadata and path safety.
 */
/**
 * Fails S0, marks the version failed, and throws a classified error.
 * @param {object} ctx IngestStageContext.
 * @param {{ code: string, failureClass: string, message: string }} failure Failure.
 * @returns {Promise<never>}
 */
async function failValidateUpload(ctx, failure) {
  if (ctx.scope.sourceVersionId) {
    await markSourceVersionFailed({
      orgId: ctx.scope.orgId,
      sourceVersionId: ctx.scope.sourceVersionId,
    });
  }
  throw createJobFailureError(failure);
}

/**
 * Runs S0 validate_upload.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{ outcome: 'completed', cursor: null }>}
 */
export async function runValidateUploadStage(ctx) {
  await ctx.emitEvent(buildSourceReceivedEvent());

  const version = ctx.carry.sourceVersion;
  if (!version) {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'INGEST_SOURCE_VERSION_NOT_FOUND',
      message: 'The source version for this job was not found.',
    });
  }

  if (String(version.orgId) !== ctx.scope.orgId || String(version.projectId) !== ctx.scope.projectId) {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'INGEST_TENANT_MISMATCH',
      message: 'The source version does not belong to this job organization or project.',
    });
  }

  if (version.status && version.status !== 'A') {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'INGEST_SOURCE_VERSION_INACTIVE',
      message: 'The source version is no longer active.',
    });
  }

  if (version.versionLifecycle !== 'received') {
    await failValidateUpload(ctx, {
      failureClass: 'user_action_required',
      code: 'INGEST_VERSION_NOT_PENDING',
      message: 'This source version is not awaiting ingest. Upload a new archive to continue.',
    });
  }

  try {
    assertKnownExclusionRulesetId(version.exclusionRulesetId);
  } catch {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'SOURCE_UNKNOWN_EXCLUSION_RULESET',
      message: 'The exclusion ruleset recorded on this upload is no longer supported.',
    });
  }

  const files = await listSourceFilesOrdered({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });

  if (files.length === 0) {
    await failValidateUpload(ctx, {
      failureClass: 'user_action_required',
      code: 'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS',
      message: 'No usable files remain after exclusions. Upload a cleaner archive.',
    });
  }

  for (const file of files) {
    if (ctx.signal?.aborted) {
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }
    const normalized = normalizeArchivePath(file.path);
    if (normalized !== file.path || isUnsafeArchivePath(normalized)) {
      await failValidateUpload(ctx, {
        failureClass: 'user_action_required',
        code: 'SOURCE_PATH_UNSAFE',
        message: 'A stored path is unsafe. Upload a cleaner archive.',
      });
    }
  }

  const filesTotal = await countSourceFilesForVersion({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  ctx.counters.filesTotal = filesTotal;

  await ctx.emitEvent(buildSourceValidatedEvent(filesTotal));
  await ctx.saveProgress(true);

  return { outcome: 'completed', cursor: null };
}

// --- from ingest/stages/s1StoreFiles.js ---
/**
 * S1 store_files — reconcile SourceFile rows against GridFS (not a second write).
 */
/** Above this share of failed files S1 fails as temporary instead of partial success. */
export const INGEST_MAX_FAILED_FILE_RATIO = 0.05;

/**
 * Runs S1 store_files with path-ordered cursor resume.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{
 *   outcome: 'completed' | 'completed_with_warnings',
 *   cursor: null,
 *   warnings: object[],
 * }>}
 */
export async function runStoreFilesStage(ctx) {
  const resumePath = typeof ctx.checkpoint?.cursor?.lastPath === 'string' ? ctx.checkpoint.cursor.lastPath : null;

  const allFiles = await listSourceFilesOrdered({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  ctx.counters.filesTotal = allFiles.length;

  const knownGridFsIds = new Set(allFiles.filter((file) => file.gridFsId).map((file) => String(file.gridFsId)));

  // Restore counters for paths already reconciled on a prior attempt.
  if (resumePath) {
    for (const file of allFiles) {
      if (file.path > resumePath) {
        break;
      }
      ctx.counters.filesProcessed += 1;
      ctx.counters.bytesProcessed += file.byteLength ?? 0;
      if (file.fileState === SOURCE_FILE_STATE_MISSING || file.fileState === SOURCE_FILE_STATE_CORRUPT) {
        ctx.counters.filesFailed += 1;
      }
    }
  }

  const files = resumePath ? allFiles.filter((file) => file.path > resumePath) : allFiles;

  /** @type {object[]} */
  const warnings = [];
  let lastPath = resumePath;

  for (const file of files) {
    if (ctx.signal?.aborted || (await ctx.isCancelRequested())) {
      if (lastPath) {
        await ctx.saveInProgressCursor({ lastPath }, 'store_files');
        await ctx.saveProgress(true);
      }
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }

    const gridFs = file.gridFsId ? await findSourceGridFsFileById(file.gridFsId) : null;

    if (!gridFs) {
      await updateSourceFileState({
        orgId: ctx.scope.orgId,
        sourceFileId: file._id,
        fileState: SOURCE_FILE_STATE_MISSING,
      });
      ctx.counters.filesFailed += 1;
      warnings.push({ code: 'SOURCE_FILE_MISSING', path: file.path });
    } else {
      const lengthMismatch = gridFs.length !== file.byteLength;
      const hashMismatch = !gridFs.sha256 || gridFs.sha256.toLowerCase() !== String(file.sha256).toLowerCase();
      if (lengthMismatch || hashMismatch) {
        await updateSourceFileState({
          orgId: ctx.scope.orgId,
          sourceFileId: file._id,
          fileState: SOURCE_FILE_STATE_CORRUPT,
        });
        ctx.counters.filesFailed += 1;
        warnings.push({ code: 'SOURCE_FILE_CORRUPT', path: file.path });
      } else if (file.fileState !== SOURCE_FILE_STATE_STORED) {
        await updateSourceFileState({
          orgId: ctx.scope.orgId,
          sourceFileId: file._id,
          fileState: SOURCE_FILE_STATE_STORED,
        });
      }
      ctx.counters.bytesProcessed += file.byteLength ?? 0;
    }

    ctx.counters.filesProcessed += 1;
    lastPath = file.path;
    ctx.noteFileProcessed();

    // Persist cursor on the same cadence as counter flushes (batch / interval).
    const beforeFlush = ctx.counters.filesProcessed;
    await ctx.saveProgress(false);
    // saveProgress may no-op when throttled; always keep in-memory cursor, and
    // force a cursor write every INGEST_FILE_BATCH_SIZE files.
    if (beforeFlush % INGEST_FILE_BATCH_SIZE === 0) {
      await ctx.saveInProgressCursor({ lastPath }, 'store_files');
    } else {
      ctx.checkpoint = {
        lastCompletedStage: ctx.checkpoint?.lastCompletedStage ?? 'validate_upload',
        cursor: { lastPath },
      };
    }
  }

  if (lastPath) {
    await ctx.saveInProgressCursor({ lastPath }, 'store_files');
  }

  await markOrphanGridFsObjects({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
    knownGridFsIds,
  });

  const total = Math.max(ctx.counters.filesTotal, 1);
  const failedRatio = ctx.counters.filesFailed / total;
  if (failedRatio > INGEST_MAX_FAILED_FILE_RATIO) {
    await ctx.saveProgress(true);
    throw createJobFailureError({
      failureClass: 'temporary',
      code: 'INGEST_TOO_MANY_FAILED_FILES',
      message: 'Too many files failed integrity checks. The job will retry from its checkpoint.',
    });
  }

  await ctx.emitEvent(
    buildFilesIdentifiedEvent({
      filesProcessed: ctx.counters.filesProcessed,
      filesFailed: ctx.counters.filesFailed,
    }),
  );
  await ctx.saveProgress(true);

  return {
    outcome: ctx.counters.filesFailed > 0 ? 'completed_with_warnings' : 'completed',
    cursor: null,
    warnings,
  };
}

// --- from ingest/stages/s2ExcludeApply.js ---
/**
 * S2 exclude_apply — replay Phase 23 exclusion decisions on reconciled files.
 */
/**
 * Runs S2 exclude_apply. Exclusions never fail the job.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{ outcome: 'completed', cursor: null }>}
 */
export async function runExcludeApplyStage(ctx) {
  const version = ctx.carry.sourceVersion;
  try {
    assertKnownExclusionRulesetId(version?.exclusionRulesetId);
  } catch {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'SOURCE_UNKNOWN_EXCLUSION_RULESET',
      message: 'The exclusion ruleset recorded on this upload is no longer supported.',
    });
  }

  const files = await listSourceFilesOrdered({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });

  let excludedPaths = 0;

  for (const file of files) {
    if (ctx.signal?.aborted || (await ctx.isCancelRequested())) {
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }

    // Only reconcile stored files; missing/corrupt stay failed from S1.
    if (file.fileState && file.fileState !== SOURCE_FILE_STATE_STORED) {
      continue;
    }

    const decision = evaluateUploadEntry({
      path: file.path,
      uncompressedSize: file.byteLength ?? 0,
    });

    let excludedFromGraph = false;
    let exclusionReason = null;

    if (decision.decision === 'skip') {
      // Should not normally appear in SourceFile (upload skipped them); record visibly.
      excludedFromGraph = true;
      exclusionReason = decision.reasonCode ?? 'unsupported_extension';
    } else if (decision.decision === 'accept_excluded_from_graph') {
      excludedFromGraph = true;
      exclusionReason = decision.reasonCode ?? 'file_too_large';
    }

    // Provisional unsupported_language hook — Phase 27 owns the authoritative list.
    // No-op today: evaluateUploadEntry does not emit unsupported_language.

    if (file.excludedFromGraph !== excludedFromGraph || (file.exclusionReason ?? null) !== exclusionReason) {
      await updateSourceFileExclusion({
        orgId: ctx.scope.orgId,
        sourceFileId: file._id,
        excludedFromGraph,
        exclusionReason,
      });
    }

    if (excludedFromGraph) {
      excludedPaths += 1;
      ctx.counters.filesExcluded += 1;
      if (exclusionReason) {
        ctx.counters.excludedByReason[exclusionReason] = (ctx.counters.excludedByReason[exclusionReason] ?? 0) + 1;
      }
    }

    ctx.noteFileProcessed();
    await ctx.saveProgress(false);
  }

  await ctx.emitEvent(
    buildExclusionsAppliedEvent({
      excludedPaths,
      filesProcessed: ctx.counters.filesProcessed,
      filesFailed: ctx.counters.filesFailed,
    }),
  );
  await ctx.saveProgress(true);

  return { outcome: 'completed', cursor: null };
}

// --- from ingest/stages/s5KnowledgePublish.js ---
/**
 * S5 knowledge_publish — create KnowledgeVersion from validated graph identity.
 */
/**
 * Runs the S5 knowledge publish stage.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{
 *   outcome: 'completed' | 'completed_with_warnings',
 *   cursor: object,
 *   warnings: object[],
 * }>}
 */
export async function runKnowledgePublishStage(ctx) {
  const graphIdentity = ctx.checkpoint?.cursor?.graphIdentity ?? ctx.carry?.graphIdentity ?? null;

  const published = await publishKnowledgeVersion({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
    graphIdentity,
    correlationId: ctx.scope.correlationId,
    log: ctx.logger,
  });

  ctx.carry.knowledgeVersionId = published.knowledgeVersionId;
  ctx.carry.publishedHealth = published.publishedHealth;
  ctx.carry.excludedFileCount = published.excludedFileCount;
  if (ctx.counters) {
    ctx.counters.filesExcluded = Math.max(ctx.counters.filesExcluded ?? 0, published.excludedFileCount);
  }

  await ctx.emitEvent(buildKnowledgeUpdatedEvent());
  await ctx.emitEvent(buildKnowledgeValidatedEvent());
  await ctx.saveProgress(true);

  /** @type {object[]} */
  const warnings = [];
  if (published.excludedFileCount > 0) {
    warnings.push({
      code: 'GRAPH_EXCLUSIONS',
      excludedFileCount: published.excludedFileCount,
    });
  }

  return {
    outcome: published.outcome,
    cursor: {
      ...(ctx.checkpoint?.cursor && typeof ctx.checkpoint.cursor === 'object' ? ctx.checkpoint.cursor : {}),
      knowledgeVersionId: published.knowledgeVersionId,
      publishedHealth: published.publishedHealth,
      excludedFileCount: published.excludedFileCount,
    },
    warnings,
  };
}

// --- from ingest/stages/s6Finalize.js ---
/**
 * S6 finalize — project lifecycle + knowledgeHealth via transitionLifecycle.
 */
/**
 * Maps published health to the terminal lifecycle status.
 * @param {'ready' | 'partially_available'} publishedHealth Publish outcome.
 * @returns {'knowledge_ready' | 'partially_available'}
 */
export function lifecycleStatusForPublishedHealth(publishedHealth) {
  return publishedHealth === 'ready' ? 'knowledge_ready' : 'partially_available';
}

/**
 * Runs the S6 finalize stage (project only — job terminal is owned by the worker runtime).
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{
 *   outcome: 'completed' | 'completed_with_warnings',
 *   cursor: object | null,
 *   warnings: object[],
 * }>}
 */
export async function runFinalizeStage(ctx) {
  const knowledgeVersionId = ctx.carry?.knowledgeVersionId ?? ctx.checkpoint?.cursor?.knowledgeVersionId ?? null;
  const publishedHealth = ctx.carry?.publishedHealth ?? ctx.checkpoint?.cursor?.publishedHealth ?? null;

  if (!knowledgeVersionId || !publishedHealth) {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_MISSING_KNOWLEDGE_VERSION',
      message: 'Finalize requires a published knowledge version from the previous stage.',
    });
  }

  const project = await findProjectById(ctx.scope.orgId, ctx.scope.projectId);
  if (!project) {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_PROJECT_NOT_FOUND',
      message: 'The project for this ingest job was not found.',
    });
  }

  const from = project.lifecycleStatus;
  if (from !== 'processing' && from !== 'updating') {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_INVALID_LIFECYCLE_FOR_PUBLISH',
      message: 'Project must be processing or updating before knowledge can be published.',
    });
  }

  const to = lifecycleStatusForPublishedHealth(publishedHealth);
  await transitionLifecycle({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    from,
    to,
    source: 'worker',
    knowledgeVersionId,
    knowledgeHealth: publishedHealth,
    actorUserId: null,
    reasonCode: 'knowledge_published',
  });

  await ctx.emitEvent(buildKnowledgeReadyEvent());
  await ctx.saveProgress(true);

  const excluded = Number(ctx.carry?.excludedFileCount ?? ctx.checkpoint?.cursor?.excludedFileCount ?? 0) > 0;
  const filesFailed = Number(ctx.counters?.filesFailed ?? 0) > 0;

  return {
    outcome: excluded || filesFailed ? 'completed_with_warnings' : 'completed',
    cursor: {
      knowledgeVersionId,
      publishedHealth,
    },
    warnings: [],
  };
}
