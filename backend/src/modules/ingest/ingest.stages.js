/**
 * Ordered ingest stage list, resume resolution, and S0–S6 runners.
 */
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { runCodegraphUpdateWithRecovery } from '../knowledge/knowledge.recovery.js';
import { runValidateUploadStage } from './stages/s0ValidateUpload.js';
import { runStoreFilesStage } from './stages/s1StoreFiles.js';
import { runExcludeApplyStage } from './stages/s2ExcludeApply.js';
import { runMaterializeDocsStage } from './stages/s3MaterializeDocs.js';
import { runCodegraphUpdateStage } from './stages/s4CodegraphUpdate.js';
import { runKnowledgePublishStage } from './stages/s5KnowledgePublish.js';
import { runFinalizeStage } from './stages/s6Finalize.js';

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

/**
 * S4 wrapper that applies same-job recovery on temporary CodeGraph failures.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<object>}
 */
async function runCodegraphUpdateStageWithRecovery(ctx) {
  return runCodegraphUpdateWithRecovery(ctx, {
    runS4: runCodegraphUpdateStage,
  });
}

/** Full S0–S6 pipeline. */
export const INGEST_STAGES = Object.freeze([
  Object.freeze({ name: 'validate_upload', run: runValidateUploadStage }),
  Object.freeze({ name: 'store_files', run: runStoreFilesStage }),
  Object.freeze({ name: 'exclude_apply', run: runExcludeApplyStage }),
  Object.freeze({ name: 'materialize_docs', run: runMaterializeDocsStage }),
  Object.freeze({ name: 'codegraph_update', run: runCodegraphUpdateStageWithRecovery }),
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
