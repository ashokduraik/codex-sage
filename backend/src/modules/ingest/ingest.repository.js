/**
 * Tenant-scoped ingest reads/writes for SourceVersion, SourceFile, and GridFS.
 */
import mongoose from 'mongoose';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { SourceFile } from '../sources/sourceFile.model.js';
import { SourceVersion } from '../sources/sourceVersion.model.js';
import {
  SOURCE_FILE_STATE_CORRUPT,
  SOURCE_FILE_STATE_MISSING,
  SOURCE_FILE_STATE_STORED,
} from '../sources/sources.constants.js';
import {
  buildSourceGridFsFilename,
  findSourceGridFsFileById,
  listSourceGridFsFilesForVersion,
  markGridFsFilesOrphaned,
} from '../sources/gridfs.js';

// Re-export state constants and GridFS helpers used by stages.
export {
  SOURCE_FILE_STATE_CORRUPT,
  SOURCE_FILE_STATE_MISSING,
  SOURCE_FILE_STATE_STORED,
  findSourceGridFsFileById,
  listSourceGridFsFilesForVersion,
};

/**
 * Loads an active SourceVersion scoped to the job's org and project.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Tenant + version scope.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function loadSourceVersionForIngest(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(scope.sourceVersionId)) {
    return null;
  }
  return SourceVersion.findOne({
    _id: scope.sourceVersionId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * Marks a SourceVersion as failed (S0 permanent failures).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} input Scope.
 * @returns {Promise<void>}
 */
export async function markSourceVersionFailed(input) {
  assertOrgId(input.orgId);
  await SourceVersion.updateOne(
    {
      _id: input.sourceVersionId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        versionLifecycle: 'failed',
        updatedAt: new Date(),
      },
    },
  ).exec();
}

/**
 * Lists active SourceFile rows for a version ordered by path.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   afterPath?: string | null,
 * }} input Scope and optional path cursor.
 * @returns {Promise<object[]>}
 */
export async function listSourceFilesOrdered(input) {
  assertOrgId(input.orgId);
  /** @type {Record<string, unknown>} */
  const filter = {
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  };
  if (input.afterPath) {
    filter.path = { $gt: input.afterPath };
  }
  return SourceFile.find(filter).sort({ path: 1 }).lean().exec();
}

/**
 * Counts active SourceFile rows for a version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<number>}
 */
export async function countSourceFilesForVersion(scope) {
  assertOrgId(scope.orgId);
  return SourceFile.countDocuments({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * Updates fileState on a SourceFile row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   sourceFileId: string | import('mongoose').Types.ObjectId,
 *   fileState: string,
 * }} input Update fields.
 * @returns {Promise<void>}
 */
export async function updateSourceFileState(input) {
  assertOrgId(input.orgId);
  await SourceFile.updateOne(
    {
      _id: input.sourceFileId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        fileState: input.fileState,
        updatedAt: new Date(),
      },
    },
  ).exec();
}

/**
 * Updates exclusion fields on a SourceFile row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   sourceFileId: string | import('mongoose').Types.ObjectId,
 *   excludedFromGraph: boolean,
 *   exclusionReason: string | null,
 * }} input Update fields.
 * @returns {Promise<void>}
 */
export async function updateSourceFileExclusion(input) {
  assertOrgId(input.orgId);
  await SourceFile.updateOne(
    {
      _id: input.sourceFileId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        excludedFromGraph: input.excludedFromGraph,
        exclusionReason: input.exclusionReason,
        updatedAt: new Date(),
      },
    },
  ).exec();
}

/**
 * Marks GridFS objects that have no matching SourceFile row as orphaned.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   knownGridFsIds: Set<string>,
 * }} input Scope and known row ids.
 * @returns {Promise<number>} Number of orphans marked.
 */
export async function markOrphanGridFsObjects(input) {
  const files = await listSourceGridFsFilesForVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
  });
  const orphanIds = files
    .filter((file) => !input.knownGridFsIds.has(String(file._id)))
    .map((file) => file._id);
  if (orphanIds.length === 0) {
    return 0;
  }
  await markGridFsFilesOrphaned(orphanIds);
  return orphanIds.length;
}

/**
 * Builds the expected GridFS filename for a SourceFile path (tests / diagnostics).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   path: string,
 * }} input Scope + path.
 * @returns {string}
 */
export function expectedGridFsFilename(input) {
  return buildSourceGridFsFilename(input);
}
