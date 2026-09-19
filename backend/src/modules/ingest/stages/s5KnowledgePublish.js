/**
 * S5 knowledge_publish — create KnowledgeVersion from validated graph identity.
 */
import { publishKnowledgeVersion } from '../../knowledge/knowledge.publish.js';
import {
  buildKnowledgeUpdatedEvent,
  buildKnowledgeValidatedEvent,
} from '../ingest.events.js';

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
  const graphIdentity =
    ctx.checkpoint?.cursor?.graphIdentity ?? ctx.carry?.graphIdentity ?? null;

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
    ctx.counters.filesExcluded = Math.max(
      ctx.counters.filesExcluded ?? 0,
      published.excludedFileCount,
    );
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
      ...(ctx.checkpoint?.cursor && typeof ctx.checkpoint.cursor === 'object'
        ? ctx.checkpoint.cursor
        : {}),
      knowledgeVersionId: published.knowledgeVersionId,
      publishedHealth: published.publishedHealth,
      excludedFileCount: published.excludedFileCount,
    },
    warnings,
  };
}
