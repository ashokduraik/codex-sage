/**
 * Tenant-scoped KnowledgeVersion reads and writes.
 */
import mongoose from 'mongoose';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { KnowledgeVersion } from './knowledgeVersion.model.js';
import { SOURCE_FILE_STATE_STORED } from '../sources/sources.constants.js';
import { SourceFile } from '../sources/sourceFile.model.js';

/**
 * Counts stored SourceFile rows excluded from the graph for a version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Tenant + version scope.
 * @returns {Promise<number>}
 */
export async function countExcludedFromGraphFiles(scope) {
  assertOrgId(scope.orgId);
  return SourceFile.countDocuments({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
    fileState: SOURCE_FILE_STATE_STORED,
    excludedFromGraph: true,
  }).exec();
}

/**
 * Finds an active KnowledgeVersion for a source version (most recent if several).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<object | null>}
 */
export async function findActiveKnowledgeVersionForSource(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(scope.sourceVersionId)) {
    return null;
  }
  return KnowledgeVersion.findOne({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ publishedAt: -1, _id: -1 })
    .lean()
    .exec();
}

/**
 * Loads an active KnowledgeVersion by id within a project.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   knowledgeVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<object | null>}
 */
export async function findKnowledgeVersionById(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(scope.knowledgeVersionId)) {
    return null;
  }
  return KnowledgeVersion.findOne({
    _id: scope.knowledgeVersionId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Inserts a KnowledgeVersion row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   graphIdentity: object,
 *   publishedHealth: string,
 *   excludedFileCount: number,
 *   publishedAt?: Date,
 *   createdBy?: string | null,
 * }} input Insert fields.
 * @returns {Promise<object>} Lean inserted document.
 */
export async function insertKnowledgeVersion(input) {
  assertOrgId(input.orgId);
  const doc = await KnowledgeVersion.create({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    graphIdentity: input.graphIdentity,
    publishedHealth: input.publishedHealth,
    excludedFileCount: input.excludedFileCount,
    publishedAt: input.publishedAt ?? new Date(),
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
    status: ROW_STATUS_ACTIVE,
  });
  return doc.toObject();
}
