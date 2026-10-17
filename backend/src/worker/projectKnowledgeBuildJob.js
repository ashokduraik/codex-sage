/**
 * Builds (or rebuilds) searchable project knowledge from a source version.
 */
import { derivePartialSuccess } from '../modules/knowledge/ingest.helper.js';
import { createJobFailureError, classifyThrownFailure, decideFailureOutcome } from './jobFailure.js';
import { hydrateSourceDiffCarry, applySourceDiffAfterValidate } from '../modules/knowledge/ingest.util.js';
import {
  INGEST_STAGES,
  resolveStagesAfter,
  buildIngestStageContext,
  INGEST_STAGE_TIMEOUT_MS,
  loadSourceVersionForIngest,
  markProjectKnowledgeFailed,
  enterIngestLifecycleAtJobStart,
} from '../modules/knowledge/ingest.js';

/**
 * Runs the knowledge-build pipeline for a claimed job.
 * @param {object} workerContext Handler context from the worker schedule.
 * @returns {Promise<{ result: 'completed' | 'completed_with_warnings', summary: object }>}
 */
export async function runProjectKnowledgeBuildJob(workerContext) {
  const job = workerContext.job;
  if (!job.sourceVersionId) {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_MISSING_SOURCE_VERSION',
      message: 'This knowledge build job has no source version.',
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
      context.logger?.info?.({ stage: stage.name }, 'knowledge build stage starting');

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
      context.logger?.info?.({ stage: stage.name }, 'knowledge build stage completed');
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
        message: 'Knowledge build was cancelled or the worker lost its lease.',
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
                message: 'A knowledge build stage exceeded its time budget.',
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
}

/** Registration for jobType project_knowledge_build. */
export const projectKnowledgeBuildHandlerRegistration = {
  type: 'project_knowledge_build',
  exclusiveScope: /** @type {'project'} */ ('project'),
  run: runProjectKnowledgeBuildJob,
};

/** Registration for jobType project_knowledge_rebuild (full rebuild, same pipeline). */
export const projectKnowledgeRebuildHandlerRegistration = {
  type: 'project_knowledge_rebuild',
  exclusiveScope: /** @type {'project'} */ ('project'),
  run: runProjectKnowledgeBuildJob,
};
