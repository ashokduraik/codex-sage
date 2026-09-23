/**
 * Ingest job handler — stage runner over S0–S6 with checkpoint resume.
 */
import {
  classifyThrownFailure,
  createJobFailureError,
  decideFailureOutcome,
} from '../../worker/retryPolicy.js';
import { recordAuditEvent } from '../audit/index.js';
import {
  findProjectById,
  transitionLifecycle,
} from '../projects/index.js';
import { buildIngestStageContext } from './ingest.context.js';
import { derivePartialSuccess } from './ingest.counters.js';
import { applySourceDiffAfterValidate, hydrateSourceDiffCarry } from './applySourceDiff.js';
import { loadSourceVersionForIngest } from './ingest.repository.js';
import { INGEST_STAGES, resolveStagesAfter } from './ingest.stages.js';

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

  input.log?.warn?.(
    { lifecycleStatus: from },
    'ingest started with unexpected lifecycle; continuing without transition',
  );
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
