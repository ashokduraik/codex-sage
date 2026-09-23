/**
 * SourceVersion / SourceFile persistence helpers.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  assertOrgId,
  decodeCursor,
  encodeCursor,
  ROW_STATUS_ACTIVE,
} from '../../platform/data/index.js';
import { SourceFile } from './sourceFile.model.js';
import { SourceVersion } from './sourceVersion.model.js';
import {
  SOURCE_FILE_STATE_STORED,
  SOURCE_ORIGIN_REPOSITORY,
  SOURCE_ORIGIN_UPLOAD,
  SOURCE_VERSION_LIST_PAGE_SIZE_DEFAULT,
  SOURCE_VERSION_LIST_PAGE_SIZE_MAX,
  VERSION_LIFECYCLE_RECEIVED,
} from './sources.constants.js';

/**
 * Clamps a requested source-version page size into the allowed range.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampSourceVersionListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return SOURCE_VERSION_LIST_PAGE_SIZE_DEFAULT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return SOURCE_VERSION_LIST_PAGE_SIZE_DEFAULT;
  }
  return Math.min(Math.floor(parsed), SOURCE_VERSION_LIST_PAGE_SIZE_MAX);
}

/**
 * Builds a keyset filter for createdAt/_id descending pages.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @returns {object}
 */
function keysetAfterCreatedAt(cursor) {
  const stamp = new Date(cursor.t);
  if (Number.isNaN(stamp.getTime())) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  if (!mongoose.isValidObjectId(cursor.i)) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  const id = new mongoose.Types.ObjectId(cursor.i);
  return {
    $or: [{ createdAt: { $lt: stamp } }, { createdAt: stamp, _id: { $lt: id } }],
  };
}

/**
 * Inserts a SourceVersion row.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   exclusionRulesetId: string,
 *   createdBy: string,
 *   fileCounts: { accepted: number, skipped: number, excludedFromGraph: number },
 *   jobId?: string | null,
 *   origin?: 'upload' | 'repository',
 *   commitSha?: string | null,
 *   branch?: string | null,
 *   repositoryConnectionId?: string | null,
 * }} input Version fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function insertSourceVersion(input, options = {}) {
  assertOrgId(input.orgId);
  const doc = new SourceVersion({
    _id: new mongoose.Types.ObjectId(input.sourceVersionId),
    orgId: input.orgId,
    projectId: input.projectId,
    origin:
      input.origin === SOURCE_ORIGIN_REPOSITORY ? SOURCE_ORIGIN_REPOSITORY : SOURCE_ORIGIN_UPLOAD,
    exclusionRulesetId: input.exclusionRulesetId,
    versionLifecycle: VERSION_LIFECYCLE_RECEIVED,
    jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
    commitSha: input.commitSha ?? null,
    branch: input.branch ?? null,
    repositoryConnectionId: input.repositoryConnectionId
      ? new mongoose.Types.ObjectId(input.repositoryConnectionId)
      : null,
    fileCounts: input.fileCounts,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
  });
  if (options.session) {
    await doc.save({ session: options.session });
  } else {
    await doc.save();
  }
  return doc;
}

/**
 * Sets jobId on an existing SourceVersion.
 * @param {{
 *   orgId: string,
 *   sourceVersionId: string,
 *   jobId: string,
 *   updatedBy: string,
 * }} input Update fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<void>}
 */
export async function setSourceVersionJobId(input, options = {}) {
  assertOrgId(input.orgId);
  const query = SourceVersion.updateOne(
    {
      _id: input.sourceVersionId,
      orgId: input.orgId,
    },
    {
      $set: {
        jobId: new mongoose.Types.ObjectId(input.jobId),
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    },
  );
  if (options.session) {
    query.session(options.session);
  }
  await query.exec();
}

/**
 * Inserts many SourceFile rows for a version.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   createdBy: string,
 *   files: Array<{
 *     path: string,
 *     sha256: string,
 *     byteLength: number,
 *     kind: 'code' | 'config' | 'doc',
 *     gridFsId: import('mongoose').Types.ObjectId,
 *     excludedFromGraph: boolean,
 *     exclusionReason?: string | null,
 *   }>,
 * }} input File rows.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function insertSourceFiles(input, options = {}) {
  assertOrgId(input.orgId);
  if (!input.files.length) {
    return [];
  }
  const docs = input.files.map(
    (file) =>
      new SourceFile({
        orgId: input.orgId,
        projectId: input.projectId,
        sourceVersionId: input.sourceVersionId,
        path: file.path,
        sha256: file.sha256,
        byteLength: file.byteLength,
        kind: file.kind,
        gridFsId: file.gridFsId,
        excludedFromGraph: file.excludedFromGraph,
        exclusionReason: file.exclusionReason ?? null,
        fileState: SOURCE_FILE_STATE_STORED,
        orphanedAt: null,
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
      }),
  );
  if (options.session) {
    await SourceFile.insertMany(docs, { session: options.session });
  } else {
    await SourceFile.insertMany(docs);
  }
  return docs;
}

/**
 * Counts active SourceVersion rows for a project (tests / assertions).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<number>}
 */
export async function countSourceVersions(orgId, projectId) {
  assertOrgId(orgId);
  return SourceVersion.countDocuments({ orgId, projectId });
}

/**
 * Lists active SourceFile rows for a version.
 * @param {string} orgId Tenant id.
 * @param {string} sourceVersionId Version id.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listSourceFilesForVersion(orgId, sourceVersionId) {
  assertOrgId(orgId);
  return SourceFile.find({ orgId, sourceVersionId }).sort({ path: 1 }).exec();
}

/**
 * Finds an active SourceVersion by id.
 * @param {string} orgId Tenant id.
 * @param {string} sourceVersionId Version id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findSourceVersionById(orgId, sourceVersionId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(sourceVersionId)) {
    return null;
  }
  return SourceVersion.findOne({ _id: sourceVersionId, orgId }).exec();
}

/**
 * Finds an active SourceVersion scoped to a project.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} sourceVersionId Version id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findActiveSourceVersionForProject(orgId, projectId, sourceVersionId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(sourceVersionId) || !mongoose.isValidObjectId(projectId)) {
    return null;
  }
  return SourceVersion.findOne({
    _id: sourceVersionId,
    orgId,
    projectId,
  }).exec();
}

/**
 * Lists a page of path+sha256 pairs for a version, ordered by path.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   afterPath?: string | null,
 *   limit: number,
 * }} input Scope and page.
 * @returns {Promise<Array<{ path: string, sha256: string }>>}
 */
export async function listSourceFilePathHashesPage(input) {
  assertOrgId(input.orgId);
  /** @type {Record<string, unknown>} */
  const filter = {
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
  };
  if (input.afterPath) {
    filter.path = { $gt: input.afterPath };
  }
  return SourceFile.find(filter, { path: 1, sha256: 1, _id: 0 })
    .sort({ path: 1 })
    .limit(input.limit)
    .lean()
    .exec();
}

/**
 * Lists active source versions for a project with keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ cursor?: string, limit?: unknown }} [filters] List filters.
 * @returns {Promise<{
 *   items: object[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }>}
 */
export async function listSourceVersionsByProject(orgId, projectId, filters = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
  }

  const limit = clampSourceVersionListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = {
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    status: ROW_STATUS_ACTIVE,
  };

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    Object.assign(query, keysetAfterCreatedAt(decoded));
  }

  const rows = await SourceVersion.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.createdAt.toISOString(),
      i: String(last._id),
    });
  }
  return { items, pageInfo: { nextCursor, hasMore } };
}
