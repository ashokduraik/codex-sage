/**
 * Ordered ingest stage list, resume resolution, and S4–S6 placeholders.
 */
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { runValidateUploadStage } from './stages/s0ValidateUpload.js';
import { runStoreFilesStage } from './stages/s1StoreFiles.js';
import { runExcludeApplyStage } from './stages/s2ExcludeApply.js';
import { runMaterializeDocsStage } from './stages/s3MaterializeDocs.js';

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
 * Placeholder for stages owned by later phases.
 * @param {string} stageName Stage id.
 * @returns {IngestStageDefinition}
 */
function createNotImplementedStage(stageName) {
  return {
    name: stageName,
    /**
     * @returns {never}
     */
    async run() {
      throw createJobFailureError({
        failureClass: 'permanent',
        code: 'NOT_IMPLEMENTED',
        message: `Ingest stage ${stageName} is not implemented yet.`,
      });
    },
  };
}

/** Full S0–S6 pipeline; S4–S6 throw until later phases replace them. */
export const INGEST_STAGES = Object.freeze([
  Object.freeze({ name: 'validate_upload', run: runValidateUploadStage }),
  Object.freeze({ name: 'store_files', run: runStoreFilesStage }),
  Object.freeze({ name: 'exclude_apply', run: runExcludeApplyStage }),
  Object.freeze({ name: 'materialize_docs', run: runMaterializeDocsStage }),
  Object.freeze(createNotImplementedStage('codegraph_update')),
  Object.freeze(createNotImplementedStage('knowledge_publish')),
  Object.freeze(createNotImplementedStage('finalize')),
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
