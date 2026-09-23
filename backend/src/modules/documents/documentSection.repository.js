/**
 * Tenant-scoped DocumentSection persistence (soft-delete by version/path).
 */
import { assertOrgId, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import { DocumentSection } from './documentSection.model.js';

/**
 * Soft-deletes all active sections for a source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Tenant + version scope.
 * @returns {Promise<number>} Number of rows soft-deleted.
 */
export async function softDeleteSectionsForVersion(scope) {
  assertOrgId(scope.orgId);
  const result = await DocumentSection.updateMany(
    {
      orgId: scope.orgId,
      projectId: scope.projectId,
      sourceVersionId: scope.sourceVersionId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        status: ROW_STATUS_DELETED,
        updatedAt: new Date(),
      },
    },
  ).exec();
  return result.modifiedCount;
}

/**
 * Soft-deletes active sections for one path within a version (idempotent replace).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   path: string,
 * }} input Scope + path.
 * @returns {Promise<number>} Number of rows soft-deleted.
 */
export async function softDeleteSectionsForPath(input) {
  assertOrgId(input.orgId);
  const result = await DocumentSection.updateMany(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      path: input.path,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        status: ROW_STATUS_DELETED,
        updatedAt: new Date(),
      },
    },
  ).exec();
  return result.modifiedCount;
}

/**
 * Inserts section DTOs as active DocumentSection rows.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   path: string,
 *   sections: Array<{
 *     heading: string | null,
 *     startLine: number,
 *     endLine: number,
 *     text: string,
 *     sectionIndex: number,
 *   }>,
 * }} input Rows to insert.
 * @returns {Promise<number>} Number of inserted documents.
 */
export async function insertDocumentSections(input) {
  assertOrgId(input.orgId);
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    return 0;
  }
  const now = new Date();
  const docs = input.sections.map((section) => ({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    path: input.path,
    heading: section.heading,
    startLine: section.startLine,
    endLine: section.endLine,
    text: section.text,
    sectionIndex: section.sectionIndex,
    status: ROW_STATUS_ACTIVE,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }));
  const inserted = await DocumentSection.insertMany(docs, { ordered: true });
  return inserted.length;
}

/**
 * Lists active sections for a path (tests / diagnostics).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   path: string,
 * }} input Scope + path.
 * @returns {Promise<object[]>}
 */
export async function listSectionsForPath(input) {
  assertOrgId(input.orgId);
  return DocumentSection.find({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    path: input.path,
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ sectionIndex: 1 })
    .lean()
    .exec();
}

/**
 * Counts active sections for a source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<number>}
 */
export async function countSectionsForVersion(scope) {
  assertOrgId(scope.orgId);
  return DocumentSection.countDocuments({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * Copies active sections for selected paths from one source version onto another.
 * Existing target paths are left untouched so retries stay idempotent.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   fromSourceVersionId: string | import('mongoose').Types.ObjectId,
 *   toSourceVersionId: string | import('mongoose').Types.ObjectId,
 *   paths: string[],
 * }} input Copy scope.
 * @returns {Promise<number>} Number of inserted section rows.
 */
export async function copySectionsForPaths(input) {
  assertOrgId(input.orgId);
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    return 0;
  }

  const alreadyOnTarget = await DocumentSection.distinct('path', {
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.toSourceVersionId,
    path: { $in: input.paths },
    status: ROW_STATUS_ACTIVE,
  }).exec();
  const already = new Set(alreadyOnTarget);
  const remainingPaths = input.paths.filter((filePath) => !already.has(filePath));
  if (remainingPaths.length === 0) {
    return 0;
  }

  const sourceRows = await DocumentSection.find({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.fromSourceVersionId,
    path: { $in: remainingPaths },
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
  if (sourceRows.length === 0) {
    return 0;
  }

  const now = new Date();
  const docs = sourceRows.map((row) => ({
    orgId: row.orgId,
    projectId: row.projectId,
    sourceVersionId: input.toSourceVersionId,
    path: row.path,
    heading: row.heading,
    startLine: row.startLine,
    endLine: row.endLine,
    text: row.text,
    sectionIndex: row.sectionIndex,
    status: ROW_STATUS_ACTIVE,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }));
  const inserted = await DocumentSection.insertMany(docs, { ordered: true });
  return inserted.length;
}
