/**
 * S6 finalize — project lifecycle + knowledgeHealth via transitionLifecycle.
 */
import { createJobFailureError } from '../../../worker/retryPolicy.js';
import {
  findProjectById,
  transitionLifecycle,
} from '../../projects/index.js';
import { buildKnowledgeReadyEvent } from '../ingest.events.js';

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
  const knowledgeVersionId =
    ctx.carry?.knowledgeVersionId ?? ctx.checkpoint?.cursor?.knowledgeVersionId ?? null;
  const publishedHealth =
    ctx.carry?.publishedHealth ?? ctx.checkpoint?.cursor?.publishedHealth ?? null;

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

  const excluded =
    Number(ctx.carry?.excludedFileCount ?? ctx.checkpoint?.cursor?.excludedFileCount ?? 0) > 0;
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
