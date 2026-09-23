/**
 * Post-S0 source diff hook — incremental carry for new-upload ingest only.
 */
import { findProjectById } from '../projects/index.js';
import { findKnowledgeVersionById } from '../knowledge/index.js';
import {
  carryFromSourceDiff,
  computeSourceDiff,
  findChangeSummaryForVersion,
  upsertChangeSummary,
} from '../sources/index.js';

/**
 * Applies a persisted summary onto ingest carry.
 * @param {object} ctx IngestStageContext.
 * @param {object} summary Stored summary.
 */
function applySummaryToCarry(ctx, summary) {
  const carry = carryFromSourceDiff({
    added: summary.paths?.added ?? [],
    removed: summary.paths?.removed ?? [],
    changed: summary.paths?.changed ?? [],
    unchanged: summary.paths?.unchanged ?? [],
    baseSourceVersionId: summary.previousSourceVersionId
      ? String(summary.previousSourceVersionId)
      : null,
  });
  ctx.carry.skipPaths = carry.skipPaths;
  ctx.carry.changedPaths = carry.changedPaths;
  ctx.carry.removedPaths = carry.removedPaths;
  ctx.carry.baseSourceVersionId = carry.baseSourceVersionId;
}

/**
 * Restores skip/changed/removed carry from a persisted summary when resuming.
 * @param {object} ctx IngestStageContext.
 * @param {object} job Claimed job document.
 * @returns {Promise<void>}
 */
export async function hydrateSourceDiffCarry(ctx, job) {
  if (job.jobType !== 'ingest') {
    return;
  }
  const summary = await findChangeSummaryForVersion({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  if (summary?.diffStatus === 'computed') {
    applySummaryToCarry(ctx, summary);
  }
}

/**
 * Computes and persists a path+sha256 diff after S0 for a new-upload ingest job.
 * @param {object} ctx IngestStageContext.
 * @param {object} job Claimed job document.
 * @returns {Promise<void>}
 */
export async function applySourceDiffAfterValidate(ctx, job) {
  if (job.jobType !== 'ingest') {
    return;
  }

  const existing = await findChangeSummaryForVersion({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  if (existing?.diffStatus === 'computed') {
    applySummaryToCarry(ctx, existing);
    return;
  }

  const project = await findProjectById(ctx.scope.orgId, ctx.scope.projectId);
  const knowledgeVersionId = project?.currentKnowledgeVersionId
    ? String(project.currentKnowledgeVersionId)
    : null;
  const published =
    knowledgeVersionId
      ? await findKnowledgeVersionById({
          orgId: ctx.scope.orgId,
          projectId: ctx.scope.projectId,
          knowledgeVersionId,
        })
      : null;
  const publishedSourceVersionId = published?.sourceVersionId
    ? String(published.sourceVersionId)
    : null;

  if (
    publishedSourceVersionId &&
    publishedSourceVersionId === String(ctx.scope.sourceVersionId)
  ) {
    return;
  }

  const diff = await computeSourceDiff({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    incomingSourceVersionId: ctx.scope.sourceVersionId,
    publishedSourceVersionId,
  });

  await upsertChangeSummary({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
    previousSourceVersionId: diff.baseSourceVersionId,
    knowledgeVersionId,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    unchanged: diff.unchanged,
    counts: diff.counts,
  });

  const carry = carryFromSourceDiff(diff);
  ctx.carry.skipPaths = carry.skipPaths;
  ctx.carry.changedPaths = carry.changedPaths;
  ctx.carry.removedPaths = carry.removedPaths;
  ctx.carry.baseSourceVersionId = carry.baseSourceVersionId;
}
