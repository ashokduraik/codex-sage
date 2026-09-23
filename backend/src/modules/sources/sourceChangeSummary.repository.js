/**
 * Tenant-scoped persistence for source change summaries.
 */
import mongoose from 'mongoose';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { SourceChangeSummary } from './sourceChangeSummary.model.js';

/**
 * Finds the active change summary for an incoming source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<object | null>}
 */
export async function findChangeSummaryForVersion(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(String(scope.sourceVersionId))) {
    return null;
  }
  return SourceChangeSummary.findOne({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Upserts a computed change summary for an incoming source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   previousSourceVersionId?: string | import('mongoose').Types.ObjectId | null,
 *   knowledgeVersionId?: string | import('mongoose').Types.ObjectId | null,
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   counts: { added: number, removed: number, changed: number, unchanged: number },
 * }} input Summary fields.
 * @returns {Promise<object>}
 */
export async function upsertChangeSummary(input) {
  assertOrgId(input.orgId);
  const now = new Date();
  const previousSourceVersionId = input.previousSourceVersionId
    ? new mongoose.Types.ObjectId(String(input.previousSourceVersionId))
    : null;
  const knowledgeVersionId = input.knowledgeVersionId
    ? new mongoose.Types.ObjectId(String(input.knowledgeVersionId))
    : null;
  const setFields = {
    previousSourceVersionId,
    knowledgeVersionId,
    counts: input.counts,
    paths: {
      added: input.added,
      removed: input.removed,
      changed: input.changed,
      unchanged: input.unchanged,
    },
    computedAt: now,
    diffStatus: 'computed',
    updatedAt: now,
  };
  const result = await SourceChangeSummary.findOneAndUpdate(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: setFields,
      $setOnInsert: {
        orgId: input.orgId,
        projectId: input.projectId,
        sourceVersionId: input.sourceVersionId,
        status: ROW_STATUS_ACTIVE,
        createdAt: now,
        createdBy: null,
        updatedBy: null,
      },
    },
    { upsert: true, returnDocument: 'after', lean: true },
  ).exec();
  return result;
}
