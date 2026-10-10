/**
 * knowledge/ingest.js — merged resource file.
 */
import { SourceFile } from '../../models/sourceFile.model.js';
import { SourceVersion } from '../../models/sourceVersion.model.js';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { createJobFailureError, classifyThrownFailure, decideFailureOutcome } from '../../worker/retryPolicy.js';
import { recordAuditEvent } from '../access/index.js';
import { findProjectById, transitionLifecycle } from '../masters/index.js';
import {
  createIngestCounters,
  createProgressFlusher,
  toJobProgressCounters,
  runValidateUploadStage,
  runStoreFilesStage,
  runExcludeApplyStage,
  runKnowledgePublishStage,
  runFinalizeStage,
  derivePartialSuccess,
} from './ingest.helper.js';
import { runMaterializeDocsStage, applySourceDiffAfterValidate, hydrateSourceDiffCarry } from './ingest.util.js';
import { runCodegraphUpdateWithRecovery } from './knowledge.js';
import {
  SOURCE_FILE_STATE_CORRUPT,
  SOURCE_FILE_STATE_MISSING,
  SOURCE_FILE_STATE_STORED,
  findSourceGridFsFileById,
  listSourceGridFsFilesForVersion,
  markGridFsFilesOrphaned,
} from './sources.js';
import mongoose from 'mongoose';

// --- from ingest/ingest.repository.js ---
/**
 * Tenant-scoped ingest reads/writes for SourceVersion, SourceFile, and GridFS.
 */
// Re-export state constants and GridFS helpers used by stages.
export { SOURCE_FILE_STATE_CORRUPT, SOURCE_FILE_STATE_MISSING, SOURCE_FILE_STATE_STORED, findSourceGridFsFileById, listSourceGridFsFilesForVersion };

/**
 * Loads an active SourceVersion scoped to the job's org and project.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Tenant + version scope.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function loadSourceVersionForIngest(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(scope.sourceVersionId)) {
    return null;
  }
  return SourceVersion.findOne({
    _id: scope.sourceVersionId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * Marks a SourceVersion as failed (S0 permanent failures).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} input Scope.
 * @returns {Promise<void>}
 */
export async function markSourceVersionFailed(input) {
  assertOrgId(input.orgId);
  await SourceVersion.updateOne(
    {
      _id: input.sourceVersionId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        versionLifecycle: 'failed',
        updatedAt: new Date(),
      },
    },
  ).exec();
}

/**
 * Lists active SourceFile rows for a version ordered by path.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   afterPath?: string | null,
 * }} input Scope and optional path cursor.
 * @returns {Promise<object[]>}
 */
export async function listSourceFilesOrdered(input) {
  assertOrgId(input.orgId);
  /** @type {Record<string, unknown>} */
  const filter = {
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  };
  if (input.afterPath) {
    filter.path = { $gt: input.afterPath };
  }
  return SourceFile.find(filter).sort({ path: 1 }).lean().exec();
}

/**
 * Counts active SourceFile rows for a version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<number>}
 */
export async function countSourceFilesForVersion(scope) {
  assertOrgId(scope.orgId);
  return SourceFile.countDocuments({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * Updates fileState on a SourceFile row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   sourceFileId: string | import('mongoose').Types.ObjectId,
 *   fileState: string,
 * }} input Update fields.
 * @returns {Promise<void>}
 */
export async function updateSourceFileState(input) {
  assertOrgId(input.orgId);
  await SourceFile.updateOne(
    {
      _id: input.sourceFileId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        fileState: input.fileState,
        updatedAt: new Date(),
      },
    },
  ).exec();
}

/**
 * Updates exclusion fields on a SourceFile row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   sourceFileId: string | import('mongoose').Types.ObjectId,
 *   excludedFromGraph: boolean,
 *   exclusionReason: string | null,
 * }} input Update fields.
 * @returns {Promise<void>}
 */
export async function updateSourceFileExclusion(input) {
  assertOrgId(input.orgId);
  await SourceFile.updateOne(
    {
      _id: input.sourceFileId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        excludedFromGraph: input.excludedFromGraph,
        exclusionReason: input.exclusionReason,
        updatedAt: new Date(),
      },
    },
  ).exec();
}

/**
 * Marks GridFS objects that have no matching SourceFile row as orphaned.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   knownGridFsIds: Set<string>,
 * }} input Scope and known row ids.
 * @returns {Promise<number>} Number of orphans marked.
 */
export async function markOrphanGridFsObjects(input) {
  const files = await listSourceGridFsFilesForVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
  });
  const orphanIds = files.filter((file) => !input.knownGridFsIds.has(String(file._id))).map((file) => file._id);
  if (orphanIds.length === 0) {
    return 0;
  }
  await markGridFsFilesOrphaned(orphanIds);
  return orphanIds.length;
}

/**
 * Builds the expected GridFS filename for a SourceFile path (tests / diagnostics).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   path: string,
 * }} input Scope + path.
 * @returns {string}
 */
// --- from ingest/ingest.context.js ---
/**
 * IngestStageContext — single argument every ingest stage receives.
 */
/**
 * Builds the stage context from a claimed worker context and SourceVersion.
 * Scope is taken from the job row only — never re-derived from user input.
 * @param {{
 *   workerContext: {
 *     job: object,
 *     stageCheckpoint: object | null,
 *     log: object,
 *     signal: AbortSignal,
 *     recordEvent: (event: object) => Promise<void>,
 *     saveCheckpoint: (checkpoint: object) => Promise<void>,
 *     saveProgress: (progress: object) => Promise<void>,
 *     isCancelRequested: () => Promise<boolean>,
 *   },
 *   origin: 'upload' | 'repository',
 * }} input Builder inputs.
 * @returns {object} IngestStageContext
 */
export function buildIngestStageContext(input) {
  const { workerContext, origin } = input;
  const job = workerContext.job;
  const counters = createIngestCounters();
  let currentStage = job.currentStage ?? null;

  const flusher = createProgressFlusher({
    counters,
    saveProgress: (payload) => workerContext.saveProgress(payload),
    getCurrentStage: () => currentStage,
  });

  return {
    scope: {
      orgId: String(job.orgId),
      projectId: String(job.projectId),
      sourceVersionId: job.sourceVersionId ? String(job.sourceVersionId) : null,
      jobId: String(job._id),
      correlationId: job.correlationId ?? null,
    },
    origin,
    attempt: job.attempt ?? 0,
    checkpoint: workerContext.stageCheckpoint
      ? {
          lastCompletedStage: workerContext.stageCheckpoint.lastCompletedStage ?? null,
          cursor: workerContext.stageCheckpoint.cursor,
        }
      : { lastCompletedStage: null },
    counters,
    logger: workerContext.log,
    signal: workerContext.signal,
    carry: {},
    /**
     * Emits one JobEvent via the worker runtime.
     * @param {{ eventCode: string, severity: string, message: string, data?: object }} event Event.
     * @returns {Promise<void>}
     */
    async emitEvent(event) {
      await workerContext.recordEvent(event);
    },
    /**
     * Flushes counters (throttled unless force).
     * @param {boolean} [force] Always write.
     * @returns {Promise<void>}
     */
    async saveProgress(force = false) {
      if (force) {
        await flusher.flushNow();
        return;
      }
      await flusher.maybeFlush(false);
    },
    /**
     * Notes one file for batch flush accounting.
     */
    noteFileProcessed() {
      flusher.noteFileProcessed();
    },
    /**
     * Persists a stage checkpoint and updates currentStage.
     * @param {{ lastCompletedStage: string, cursor?: unknown }} checkpoint Checkpoint.
     * @returns {Promise<void>}
     */
    async saveCheckpoint(checkpoint) {
      currentStage = checkpoint.lastCompletedStage;
      await workerContext.saveCheckpoint(checkpoint);
      await flusher.flushNow();
    },
    /**
     * Persists an intra-stage cursor without completing the stage.
     * @param {unknown} cursor Cursor payload (e.g. `{ lastPath }`).
     * @param {string} stageName Stage currently running.
     * @returns {Promise<void>}
     */
    async saveInProgressCursor(cursor, stageName) {
      currentStage = stageName;
      const lastCompleted = this.checkpoint?.lastCompletedStage ?? null;
      if (lastCompleted == null) {
        return;
      }
      await workerContext.saveCheckpoint({
        lastCompletedStage: lastCompleted,
        cursor,
        currentStage: stageName,
      });
      this.checkpoint = {
        lastCompletedStage: lastCompleted,
        cursor,
      };
    },
    /**
     * Sets the in-memory current stage (before checkpoint) for progress writes.
     * @param {string} stageName Stage id.
     */
    setCurrentStage(stageName) {
      currentStage = stageName;
    },
    /**
     * @returns {Promise<boolean>}
     */
    async isCancelRequested() {
      return workerContext.isCancelRequested();
    },
    /**
     * Snapshot of Job.progressCounters shape (tests / summary).
     * @returns {object}
     */
    jobProgressSnapshot() {
      return toJobProgressCounters(counters);
    },
  };
}

// --- from ingest/ingest.stages.js ---
/**
 * Ordered ingest stage list, resume resolution, and S0–S6 runners.
 */
/**
 * @typedef {{
 *   name: string,
 *   run: (ctx: object) => Promise<{
 *     outcome: 'completed' | 'completed_with_warnings',
 *     cursor?: unknown,
 *     warnings?: object[],
 *   }>,
 * }} IngestStageDefinition
 */

/** Full S0–S6 pipeline. */
export const INGEST_STAGES = Object.freeze([
  Object.freeze({ name: 'validate_upload', run: runValidateUploadStage }),
  Object.freeze({ name: 'store_files', run: runStoreFilesStage }),
  Object.freeze({ name: 'exclude_apply', run: runExcludeApplyStage }),
  Object.freeze({ name: 'materialize_docs', run: runMaterializeDocsStage }),
  Object.freeze({ name: 'codegraph_update', run: runCodegraphUpdateWithRecovery }),
  Object.freeze({ name: 'knowledge_publish', run: runKnowledgePublishStage }),
  Object.freeze({ name: 'finalize', run: runFinalizeStage }),
]);

/**
 * Resolves which stages remain after the last completed checkpoint.
 * @param {string | null | undefined} lastCompletedStage Checkpoint stage id.
 * @param {readonly IngestStageDefinition[]} [stages] Stage list (tests inject).
 * @returns {IngestStageDefinition[]}
 * @throws {ReturnType<typeof createJobFailureError>} When the checkpoint stage is unknown.
 */
export function resolveStagesAfter(lastCompletedStage, stages = INGEST_STAGES) {
  if (lastCompletedStage == null || lastCompletedStage === '') {
    return [...stages];
  }
  const index = stages.findIndex((stage) => stage.name === lastCompletedStage);
  if (index === -1) {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_UNKNOWN_CHECKPOINT_STAGE',
      message: 'The job checkpoint refers to an unknown ingest stage.',
    });
  }
  return stages.slice(index + 1);
}

// --- from ingest/ingest.handler.js ---
/**
 * Ingest job handler — stage runner over S0–S6 with checkpoint resume.
 */
/** Per-stage wall-clock budget before aborting as temporary. */
export const INGEST_STAGE_TIMEOUT_MS = 900_000;

/**
 * Enters processing or updating at job start so S6 publish is a legal transition.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   log?: { error?: Function, warn?: Function },
 * }} input Scope.
 * @returns {Promise<void>}
 */
export async function enterIngestLifecycleAtJobStart(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_PROJECT_NOT_FOUND',
      message: 'The project for this ingest job was not found.',
    });
  }

  const from = project.lifecycleStatus;
  if (from === 'processing' || from === 'updating') {
    return;
  }

  if (from === 'source_received') {
    await transitionLifecycle({
      orgId: input.orgId,
      projectId: input.projectId,
      from: 'source_received',
      to: 'processing',
      source: 'worker',
      actorUserId: null,
      reasonCode: 'ingest_started',
    });
    return;
  }

  if (from === 'knowledge_ready' || from === 'partially_available') {
    await transitionLifecycle({
      orgId: input.orgId,
      projectId: input.projectId,
      from,
      to: 'updating',
      source: 'worker',
      knowledgeHealth: 'updating',
      actorUserId: null,
      reasonCode: 'ingest_started',
    });
    return;
  }

  if (from === 'failed') {
    const hasPointer = Boolean(project.currentKnowledgeVersionId);
    if (hasPointer) {
      await transitionLifecycle({
        orgId: input.orgId,
        projectId: input.projectId,
        from: 'failed',
        to: 'updating',
        source: 'worker',
        knowledgeHealth: 'updating',
        actorUserId: null,
        reasonCode: 'ingest_started',
      });
      return;
    }
    await transitionLifecycle({
      orgId: input.orgId,
      projectId: input.projectId,
      from: 'failed',
      to: 'processing',
      source: 'worker',
      actorUserId: null,
      reasonCode: 'ingest_started',
    });
    return;
  }

  input.log?.warn?.({ lifecycleStatus: from }, 'ingest started with unexpected lifecycle; continuing without transition');
}

/**
 * Marks project knowledge failed when the job will not be requeued.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   failureCode: string,
 *   correlationId?: string | null,
 *   log?: { error?: Function },
 * }} input Failure context.
 * @returns {Promise<void>}
 */
export async function markProjectKnowledgeFailed(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    return;
  }
  const from = project.lifecycleStatus;
  if (from !== 'processing' && from !== 'updating') {
    return;
  }

  await transitionLifecycle({
    orgId: input.orgId,
    projectId: input.projectId,
    from,
    to: 'failed',
    source: 'worker',
    knowledgeHealth: 'failed',
    actorUserId: null,
    reasonCode: 'knowledge_failed',
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: null,
      action: 'knowledge.failed',
      resourceType: 'knowledge',
      resourceId: input.projectId,
      result: 'failed',
      correlationId: input.correlationId ?? null,
      context: {
        projectId: String(input.projectId),
        sourceVersionId: String(input.sourceVersionId),
        code: input.failureCode,
      },
    },
    { log: input.log },
  );
}

/**
 * Runs one stage with a wall-clock timeout and cancel/abort awareness.
 * @param {{
 *   stage: { name: string, run: (ctx: object) => Promise<object> },
 *   context: object,
 *   timeoutMs?: number,
 * }} input Stage run inputs.
 * @returns {Promise<object>}
 */
async function runStageWithTimeout(input) {
  const timeoutMs = input.timeoutMs ?? INGEST_STAGE_TIMEOUT_MS;
  const { stage, context } = input;

  if (context.signal?.aborted || (await context.isCancelRequested())) {
    throw createJobFailureError({
      failureClass: 'temporary',
      code: 'INGEST_ABORTED',
      message: 'Ingest was cancelled or the worker lost its lease.',
    });
  }

  let timeoutId;
  try {
    const result = await Promise.race([
      stage.run(context),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            createJobFailureError({
              failureClass: 'temporary',
              code: 'INGEST_STAGE_TIMEOUT',
              message: 'An ingest stage exceeded its time budget.',
            }),
          );
        }, timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Executes the ingest pipeline for a claimed job.
 * @param {object} workerContext Handler context from the worker runtime.
 * @returns {Promise<{ result: 'completed' | 'completed_with_warnings', summary: object }>}
 */
export async function runIngestJob(workerContext) {
  const job = workerContext.job;
  if (!job.sourceVersionId) {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_MISSING_SOURCE_VERSION',
      message: 'This ingest job has no source version.',
    });
  }

  const version = await loadSourceVersionForIngest({
    orgId: job.orgId,
    projectId: job.projectId,
    sourceVersionId: job.sourceVersionId,
  });
  if (!version) {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_SOURCE_VERSION_NOT_FOUND',
      message: 'The source version for this job was not found in this project.',
    });
  }

  await enterIngestLifecycleAtJobStart({
    orgId: String(job.orgId),
    projectId: String(job.projectId),
    log: workerContext.log,
  });

  const context = buildIngestStageContext({
    workerContext,
    origin: version.origin === 'repository' ? 'repository' : 'upload',
  });
  context.carry.sourceVersion = version;

  const lastCompleted = workerContext.stageCheckpoint?.lastCompletedStage ?? null;
  const remaining = resolveStagesAfter(lastCompleted, INGEST_STAGES);
  await hydrateSourceDiffCarry(context, job);

  try {
    for (const stage of remaining) {
      context.setCurrentStage(stage.name);
      context.logger?.info?.({ stage: stage.name }, 'ingest stage starting');

      const stageResult = await runStageWithTimeout({ stage, context });
      if (stage.name === 'validate_upload') {
        await applySourceDiffAfterValidate(context, job);
      }

      const checkpoint = {
        lastCompletedStage: stage.name,
      };
      if (stageResult && Object.prototype.hasOwnProperty.call(stageResult, 'cursor')) {
        checkpoint.cursor = stageResult.cursor;
      } else {
        checkpoint.cursor = null;
      }
      await context.saveCheckpoint(checkpoint);
      context.checkpoint = {
        lastCompletedStage: stage.name,
        cursor: checkpoint.cursor,
      };
      context.logger?.info?.({ stage: stage.name }, 'ingest stage completed');
    }

    const partialSuccess = derivePartialSuccess(context.counters, true);
    return {
      result: partialSuccess ? 'completed_with_warnings' : 'completed',
      summary: {
        filesProcessed: context.counters.filesProcessed,
        filesFailed: context.counters.filesFailed,
        filesExcluded: context.counters.filesExcluded,
        partialSuccess,
      },
    };
  } catch (err) {
    const classified = classifyThrownFailure(err);
    const decision = decideFailureOutcome({
      failure: classified,
      attempt: job.attempt ?? 1,
      maxAttempts: workerContext.maxAttempts ?? job.maxAttempts,
    });
    if (decision.action === 'fail') {
      await markProjectKnowledgeFailed({
        orgId: String(job.orgId),
        projectId: String(job.projectId),
        sourceVersionId: String(job.sourceVersionId),
        failureCode: decision.code,
        correlationId: job.correlationId ?? null,
        log: workerContext.log,
      });
    }
    throw err;
  }
}

/**
 * Registration descriptor for the ingest handler.
 */
export const ingestHandlerRegistration = {
  type: 'ingest',
  exclusiveScope: /** @type {'project'} */ ('project'),
  run: runIngestJob,
};

/**
 * Reingest uses the same pipeline; skipPaths stay empty for a full rebuild.
 */
export const reingestHandlerRegistration = {
  type: 'reingest',
  exclusiveScope: /** @type {'project'} */ ('project'),
  run: runIngestJob,
};

export {
  INGEST_FILE_BATCH_SIZE,
  INGEST_PROGRESS_FLUSH_MS,
  createIngestCounters,
  toJobProgressCounters,
  derivePartialSuccess,
  createProgressFlusher,
  INGEST_MAX_FAILED_FILE_RATIO,
} from './ingest.helper.js';
export { applySourceDiffAfterValidate, hydrateSourceDiffCarry, runMaterializeDocsStage, runCodegraphUpdateStage } from './ingest.util.js';
