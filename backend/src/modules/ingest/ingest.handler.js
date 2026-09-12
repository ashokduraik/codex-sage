/**
 * Ingest job handler — stage runner over S0–S6 with checkpoint resume.
 */
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { buildIngestStageContext } from './ingest.context.js';
import { derivePartialSuccess } from './ingest.counters.js';
import { loadSourceVersionForIngest } from './ingest.repository.js';
import { INGEST_STAGES, resolveStagesAfter } from './ingest.stages.js';

/** Per-stage wall-clock budget before aborting as temporary. */
export const INGEST_STAGE_TIMEOUT_MS = 900_000;

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

  const context = buildIngestStageContext({
    workerContext,
    origin: version.origin === 'repository' ? 'repository' : 'upload',
  });
  context.carry.sourceVersion = version;

  const lastCompleted = workerContext.stageCheckpoint?.lastCompletedStage ?? null;
  const remaining = resolveStagesAfter(lastCompleted, INGEST_STAGES);

  for (const stage of remaining) {
    context.setCurrentStage(stage.name);
    context.logger?.info?.({ stage: stage.name }, 'ingest stage starting');

    const stageResult = await runStageWithTimeout({ stage, context });

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
}

/**
 * Registration descriptor for the ingest handler.
 */
export const ingestHandlerRegistration = {
  type: 'ingest',
  exclusiveScope: /** @type {'project'} */ ('project'),
  run: runIngestJob,
};
