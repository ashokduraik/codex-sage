/**
 * knowledge/sources.js — merged resource file.
 */
import { z } from 'zod';
import path from 'node:path';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../../platform/errors.js';
import { isUnsafeArchivePath, normalizeArchivePath } from './uploads.js';
import { SourceChangeSummary } from '../../models/sourceChangeSummary.model.js';
import { createPendingJob, findActiveJobForSourceVersion } from '../masters/index.js';
import { assertOrgId, decodeCursor, encodeCursor, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import {
  SourceVersion,
  SOURCE_ORIGIN_UPLOAD,
  SOURCE_ORIGIN_REPOSITORY,
  VERSION_LIFECYCLE_VALUES,
  VERSION_LIFECYCLE_RECEIVED,
} from '../../models/sourceVersion.model.js';
import {
  SourceFile,
  SOURCE_FILE_KIND_VALUES,
  SOURCE_FILE_STATE_STORED,
  SOURCE_FILE_STATE_VALUES,
  SOURCE_FILE_STATE_CORRUPT,
  SOURCE_FILE_STATE_MISSING,
} from '../../models/sourceFile.model.js';

export { SourceFile } from '../../models/sourceFile.model.js';

export { SourceVersion } from '../../models/sourceVersion.model.js';

export { SourceChangeSummary };

// --- from sources/sources.constants.js ---
/**
 * Source upload persistence constants (not env).
 */

/** GridFS bucket for accepted source/doc bytes. */
export const GRIDFS_SOURCE_BUCKET = 'sourceFiles';

/** Content hash algorithm for accepted files and archive identity. */
export const UPLOAD_HASH_ALGORITHM = 'sha256';

/** Multipart allows a single archive field. */
export const MULTIPART_MAX_FILES = 1;

/** Multipart form field name for the zip archive. */
export const ARCHIVE_FIELD_NAME = 'archive';

export {
  SOURCE_ORIGIN_UPLOAD,
  SOURCE_ORIGIN_REPOSITORY,
  VERSION_LIFECYCLE_VALUES,
  VERSION_LIFECYCLE_RECEIVED,
  SOURCE_FILE_KIND_VALUES,
  SOURCE_FILE_STATE_VALUES,
  SOURCE_FILE_STATE_STORED,
  SOURCE_FILE_STATE_MISSING,
  SOURCE_FILE_STATE_CORRUPT,
};

/** Default page size for GET /knowledge/sources/listVersions/:projectId. */
export const SOURCE_VERSION_LIST_PAGE_SIZE_DEFAULT = 20;

/** Hard cap on the source-versions `limit` query parameter. */
export const SOURCE_VERSION_LIST_PAGE_SIZE_MAX = 100;

// --- from sources/gridfs.js ---
/**
 * GridFS bucket helper for accepted source file bytes.
 */
/**
 * Returns the shared GridFS bucket for source uploads.
 * @param {import('mongoose').Connection} [connection] Mongoose connection (default default).
 * @returns {import('mongodb').GridFSBucket}
 */
export function getSourceFilesBucket(connection = mongoose.connection) {
  const db = connection.db;
  if (!db) {
    throw new Error('MongoDB connection is not ready for GridFS');
  }
  return new mongoose.mongo.GridFSBucket(db, { bucketName: GRIDFS_SOURCE_BUCKET });
}

/**
 * Builds the tenant-safe GridFS filename for an accepted path.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   path: string,
 * }} input Scope + relative path.
 * @returns {string}
 */
export function buildSourceGridFsFilename(input) {
  return `${input.orgId}/${input.projectId}/${input.sourceVersionId}/${input.path}`;
}

/**
 * Stamps orphanedAt on GridFS file documents (best-effort; never throws to callers).
 * @param {import('mongodb').ObjectId[]} gridFsIds Written file ids.
 * @param {import('mongoose').Connection} [connection] Connection.
 * @returns {Promise<void>}
 */
export async function markGridFsFilesOrphaned(gridFsIds, connection = mongoose.connection) {
  if (!Array.isArray(gridFsIds) || gridFsIds.length === 0) {
    return;
  }
  const db = connection.db;
  if (!db) {
    return;
  }
  const files = db.collection(`${GRIDFS_SOURCE_BUCKET}.files`);
  const now = new Date();
  await files.updateMany({ _id: { $in: gridFsIds } }, { $set: { 'metadata.orphanedAt': now } });
}

/**
 * Reads GridFS file metadata by id for ingest reconciliation.
 * @param {import('mongoose').Types.ObjectId | string} gridFsId File id.
 * @param {import('mongoose').Connection} [connection] Connection.
 * @returns {Promise<{ length: number, sha256: string | null } | null>}
 */
export async function findSourceGridFsFileById(gridFsId, connection = mongoose.connection) {
  const db = connection.db;
  if (!db) {
    return null;
  }
  const id = gridFsId instanceof mongoose.Types.ObjectId ? gridFsId : new mongoose.Types.ObjectId(String(gridFsId));
  const doc = await db.collection(`${GRIDFS_SOURCE_BUCKET}.files`).findOne({ _id: id });
  if (!doc) {
    return null;
  }
  return {
    length: typeof doc.length === 'number' ? doc.length : 0,
    sha256: doc.metadata && typeof doc.metadata.sha256 === 'string' ? doc.metadata.sha256 : null,
  };
}

/**
 * Lists GridFS files for a source version by filename prefix.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 * }} scope Scope strings.
 * @param {import('mongoose').Connection} [connection] Connection.
 * @returns {Promise<Array<{ _id: import('mongoose').Types.ObjectId, filename: string }>>}
 */
export async function listSourceGridFsFilesForVersion(scope, connection = mongoose.connection) {
  const db = connection.db;
  if (!db) {
    return [];
  }
  const prefix = `${scope.orgId}/${scope.projectId}/${scope.sourceVersionId}/`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const docs = await db
    .collection(`${GRIDFS_SOURCE_BUCKET}.files`)
    .find({ filename: { $regex: `^${escaped}` } })
    .toArray();
  return docs.map((doc) => ({ _id: doc._id, filename: doc.filename }));
}

/**
 * Opens a readable download stream for a stored GridFS source object.
 * @param {import('mongoose').Types.ObjectId | string} gridFsId File id.
 * @param {import('mongoose').Connection} [connection] Connection.
 * @returns {import('mongodb').GridFSBucketReadStream}
 */
export function openSourceGridFsDownloadStream(gridFsId, connection = mongoose.connection) {
  const bucket = getSourceFilesBucket(connection);
  const id = gridFsId instanceof mongoose.Types.ObjectId ? gridFsId : new mongoose.Types.ObjectId(String(gridFsId));
  return bucket.openDownloadStream(id);
}

/**
 * Reads GridFS file bytes into a buffer.
 * @param {import('mongoose').Types.ObjectId | string} gridFsId File id.
 * @param {import('mongoose').Connection} [connection] Connection.
 * @returns {Promise<Buffer>}
 */
export async function readSourceGridFsBytes(gridFsId, connection = mongoose.connection) {
  const stream = openSourceGridFsDownloadStream(gridFsId, connection);
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

// --- from sources/workspacePaths.js ---
/**
 * Tenant-safe workspace path join and boundary checks.
 */
/**
 * Builds the absolute project workspace directory under WORKSPACE_ROOT.
 * @param {string} workspaceRoot Absolute WORKSPACE_ROOT.
 * @param {string} orgId Organization id.
 * @param {string} projectId Project id.
 * @returns {string} Absolute project workspace path.
 * @throws {Error} When ids are empty or the resolved path escapes the root.
 */
export function resolveProjectWorkspacePath(workspaceRoot, orgId, projectId) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    throw Object.assign(new Error('WORKSPACE_ROOT must be an absolute path.'), {
      code: 'WORKSPACE_ROOT_INVALID',
    });
  }
  const org = String(orgId ?? '');
  const project = String(projectId ?? '');
  if (!org || !project || org.includes('..') || project.includes('..') || org.includes('/') || project.includes('/')) {
    throw Object.assign(new Error('Organization or project id is unsafe for a workspace path.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
  const resolvedRoot = path.resolve(workspaceRoot);
  const projectPath = path.resolve(resolvedRoot, org, project);
  assertPathInsideRoot(resolvedRoot, projectPath);
  return projectPath;
}

/**
 * Resolves a repo-relative file path under the project workspace; fails closed on escape.
 * @param {string} workspacePath Absolute project workspace directory.
 * @param {string} relativePath Repo-relative path (may need normalization).
 * @returns {string} Absolute file path under workspacePath.
 * @throws {{ code: string, message: string }} When the path is unsafe.
 */
export function resolveSafeWorkspaceFilePath(workspacePath, relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  if (isUnsafeArchivePath(normalized)) {
    throw Object.assign(new Error('Source path is unsafe for workspace materialization.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
  const resolvedRoot = path.resolve(workspacePath);
  const absoluteFile = path.resolve(resolvedRoot, ...normalized.split('/'));
  assertPathInsideRoot(resolvedRoot, absoluteFile);
  return absoluteFile;
}

/**
 * Asserts that candidate stays under root (or equals root).
 * @param {string} root Absolute root directory.
 * @param {string} candidate Absolute candidate path.
 * @returns {void}
 * @throws {{ code: string, message: string }}
 */
export function assertPathInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) {
    return;
  }
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (!resolvedCandidate.startsWith(prefix)) {
    throw Object.assign(new Error('Resolved path escapes the workspace root.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
}

// --- from sources/workspaceMaterialize.js ---
/**
 * GridFS → disk materialization and project workspace subtree reset.
 */
/**
 * Removes all entries under the project workspace directory without deleting WORKSPACE_ROOT.
 * Creates the directory when missing.
 * @param {string} workspacePath Absolute project workspace path.
 * @param {string} workspaceRoot Absolute WORKSPACE_ROOT (must be a strict ancestor).
 * @returns {Promise<void>}
 */
export async function resetProjectWorkspaceSubtree(workspacePath, workspaceRoot) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedProject = path.resolve(workspacePath);
  assertPathInsideRoot(resolvedRoot, resolvedProject);
  if (resolvedProject === resolvedRoot) {
    throw Object.assign(new Error('Refusing to reset WORKSPACE_ROOT itself.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
  await fs.rm(resolvedProject, { recursive: true, force: true });
  await fs.mkdir(resolvedProject, { recursive: true });
}

/**
 * Deletes one repo-relative file from the project workspace (missing is ok).
 * @param {string} workspacePath Absolute project workspace path.
 * @param {string} relativePath Repo-relative path.
 * @returns {Promise<void>}
 */
export async function deleteWorkspaceRelativePath(workspacePath, relativePath) {
  const absoluteFile = resolveSafeWorkspaceFilePath(workspacePath, relativePath);
  await fs.rm(absoluteFile, { force: true });
}

/**
 * Streams one GridFS object to a safe path under the project workspace.
 * @param {{
 *   workspacePath: string,
 *   relativePath: string,
 *   gridFsId: import('mongoose').Types.ObjectId | string,
 * }} input Materialize inputs.
 * @returns {Promise<string>} Absolute path written.
 */
export async function materializeGridFsFileToDisk(input) {
  const absoluteFile = resolveSafeWorkspaceFilePath(input.workspacePath, input.relativePath);
  await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
  const download = openSourceGridFsDownloadStream(input.gridFsId);
  try {
    await pipeline(download, createWriteStream(absoluteFile));
  } catch (err) {
    // Best-effort cleanup of a partial write.
    await fs.rm(absoluteFile, { force: true }).catch(() => {});
    throw err;
  }
  return absoluteFile;
}

// --- from sources/sourceDiff.js ---
/**
 * Path + sha256 source-version diff used by ingest (Phase 29).
 */
/** Paths loaded per query batch when comparing two versions. */
export const SOURCE_DIFF_BATCH_SIZE = 500;

/**
 * Classifies two path+hash maps into added/removed/changed/unchanged sets.
 * @param {Map<string, string>} incomingByPath Incoming version path → sha256.
 * @param {Map<string, string> | null} publishedByPath Last published path → sha256, or null.
 * @returns {{
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   counts: { added: number, removed: number, changed: number, unchanged: number },
 * }}
 */
export function classifySourceDiff(incomingByPath, publishedByPath) {
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  if (!publishedByPath || publishedByPath.size === 0) {
    const allAdded = [...incomingByPath.keys()].sort();
    return {
      added: allAdded,
      removed: [],
      changed: [],
      unchanged: [],
      counts: {
        added: allAdded.length,
        removed: 0,
        changed: 0,
        unchanged: 0,
      },
    };
  }

  for (const [filePath, sha256] of incomingByPath) {
    const priorHash = publishedByPath.get(filePath);
    if (priorHash === undefined) {
      added.push(filePath);
    } else if (priorHash === sha256) {
      unchanged.push(filePath);
    } else {
      changed.push(filePath);
    }
  }

  for (const filePath of publishedByPath.keys()) {
    if (!incomingByPath.has(filePath)) {
      removed.push(filePath);
    }
  }

  added.sort();
  removed.sort();
  changed.sort();
  unchanged.sort();

  return {
    added,
    removed,
    changed,
    unchanged,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
  };
}

/**
 * Loads all active path+sha256 pairs for a source version in batches.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   batchSize?: number,
 * }} input Scope.
 * @returns {Promise<Map<string, string>>}
 */
export async function loadPathHashesForVersion(input) {
  const batchSize = input.batchSize ?? SOURCE_DIFF_BATCH_SIZE;
  /** @type {Map<string, string>} */
  const byPath = new Map();
  let afterPath = null;
  for (;;) {
    const page = await listSourceFilePathHashesPage({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      afterPath,
      limit: batchSize,
    });
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      byPath.set(row.path, row.sha256);
    }
    if (page.length < batchSize) {
      break;
    }
    afterPath = page[page.length - 1].path;
  }
  return byPath;
}

/**
 * Compares an incoming source version to the last published one.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   incomingSourceVersionId: string | import('mongoose').Types.ObjectId,
 *   publishedSourceVersionId?: string | import('mongoose').Types.ObjectId | null,
 * }} input Versions to compare.
 * @returns {Promise<{
 *   baseSourceVersionId: string | null,
 *   incomingSourceVersionId: string,
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   counts: { added: number, removed: number, changed: number, unchanged: number },
 * }>}
 */
export async function computeSourceDiff(input) {
  const incomingByPath = await loadPathHashesForVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.incomingSourceVersionId,
  });
  const publishedId = input.publishedSourceVersionId ? String(input.publishedSourceVersionId) : null;
  const publishedByPath =
    publishedId && publishedId !== String(input.incomingSourceVersionId)
      ? await loadPathHashesForVersion({
          orgId: input.orgId,
          projectId: input.projectId,
          sourceVersionId: publishedId,
        })
      : null;
  const classified = classifySourceDiff(incomingByPath, publishedByPath);
  return {
    baseSourceVersionId: publishedByPath ? publishedId : null,
    incomingSourceVersionId: String(input.incomingSourceVersionId),
    ...classified,
  };
}

/**
 * Derives ingest carry path sets from a computed diff.
 * @param {{
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   baseSourceVersionId?: string | null,
 * }} diff Diff DTO.
 * @returns {{
 *   skipPaths: Set<string>,
 *   changedPaths: string[],
 *   removedPaths: string[],
 *   baseSourceVersionId: string | null,
 * }}
 */
export function carryFromSourceDiff(diff) {
  return {
    skipPaths: new Set(diff.unchanged),
    changedPaths: [...diff.changed, ...diff.added],
    removedPaths: [...diff.removed],
    baseSourceVersionId: diff.baseSourceVersionId ?? null,
  };
}

// --- from sources/sources.repository.js ---
/**
 * SourceVersion / SourceFile persistence helpers.
 */
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
    origin: input.origin === SOURCE_ORIGIN_REPOSITORY ? SOURCE_ORIGIN_REPOSITORY : SOURCE_ORIGIN_UPLOAD,
    exclusionRulesetId: input.exclusionRulesetId,
    versionLifecycle: VERSION_LIFECYCLE_RECEIVED,
    jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
    commitSha: input.commitSha ?? null,
    branch: input.branch ?? null,
    repositoryConnectionId: input.repositoryConnectionId ? new mongoose.Types.ObjectId(input.repositoryConnectionId) : null,
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
  return SourceVersion.countDocuments({ orgId, projectId, status: ROW_STATUS_ACTIVE });
}

/**
 * Finds an active stored SourceFile by normalized path.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   path: string,
 * }} scope Scope + path.
 * @returns {Promise<object | null>}
 */
export async function findSourceFileByPath(scope) {
  assertOrgId(scope.orgId);
  if (!scope.path) {
    return null;
  }
  return SourceFile.findOne({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    path: scope.path,
    status: ROW_STATUS_ACTIVE,
    fileState: SOURCE_FILE_STATE_STORED,
  })
    .lean()
    .exec();
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
  return SourceFile.find(filter, { path: 1, sha256: 1, _id: 0 }).sort({ path: 1 }).limit(input.limit).lean().exec();
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

// --- from sources/sources.service.js ---
/**
 * Source version HTTP use cases (project_knowledge_rebuild).
 */
/**
 * Formats a date as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

/**
 * Maps a SourceVersion document to the list DTO.
 * @param {object} version SourceVersion document or lean object.
 * @returns {object}
 */
export function mapSourceVersionToListDto(version) {
  const counts = version.fileCounts ?? {};
  return {
    id: String(version._id ?? version.id),
    origin: version.origin,
    versionLifecycle: version.versionLifecycle,
    fileCounts: {
      accepted: counts.accepted ?? 0,
      skipped: counts.skipped ?? 0,
      excludedFromGraph: counts.excludedFromGraph ?? 0,
    },
    jobId: version.jobId ? String(version.jobId) : null,
    commitSha: version.commitSha ?? null,
    branch: version.branch ?? null,
    createdBy: version.createdBy ? String(version.createdBy) : null,
    createdAt: toIsoOrNull(version.createdAt),
  };
}

/**
 * Lists source versions for a project (caller already passed project ACL).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ cursor?: string, limit?: unknown }} [query] List query.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listProjectSourceVersions(orgId, projectId, query = {}) {
  const result = await listSourceVersionsByProject(orgId, projectId, query);
  return {
    items: result.items.map(mapSourceVersionToListDto),
    pageInfo: result.pageInfo,
  };
}

/**
 * Enqueues a project_knowledge_rebuild job for an existing source version, or returns the active one.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   actorUserId: string,
 *   correlationId?: string | null,
 * }} input Scope and actor.
 * @returns {Promise<{ jobId: string, sourceVersionId: string, jobType: string }>}
 */
export async function enqueueSourceReingest(input) {
  const version = await findActiveSourceVersionForProject(input.orgId, input.projectId, input.sourceVersionId);
  if (!version) {
    throw ApiError.fromCode('SOURCE_VERSION_NOT_FOUND');
  }

  const active = await findActiveJobForSourceVersion(input.orgId, input.projectId, input.sourceVersionId);
  if (active) {
    return {
      jobId: String(active._id),
      sourceVersionId: String(version._id),
      jobType: String(active.jobType),
    };
  }

  const pending = await createPendingJob({
    orgId: input.orgId,
    projectId: input.projectId,
    jobType: 'project_knowledge_rebuild',
    createdBy: input.actorUserId,
    correlationId: input.correlationId ?? null,
    sourceVersionId: String(version._id),
  });

  return {
    jobId: pending.jobId,
    sourceVersionId: String(version._id),
    jobType: 'project_knowledge_rebuild',
  };
}

/**
 * Finds the newest active source version for a project, preferring a matching commit SHA.
 * Used by manual repository sync when HEAD is unchanged so knowledge can rebuild without a new pull.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   commitSha?: string | null,
 * }} input Scope and optional commit filter preference.
 * @returns {Promise<{ _id: import('mongoose').Types.ObjectId } | null>}
 */
export async function findLatestActiveSourceVersionForProject(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId)) {
    return null;
  }
  const projectObjectId = new mongoose.Types.ObjectId(String(input.projectId));
  const commitSha = input.commitSha ? String(input.commitSha) : null;
  if (commitSha) {
    const matchingCommit = await SourceVersion.findOne({
      orgId: input.orgId,
      projectId: projectObjectId,
      status: ROW_STATUS_ACTIVE,
      commitSha,
    })
      .sort({ createdAt: -1, _id: -1 })
      .select({ _id: 1 })
      .lean()
      .exec();
    if (matchingCommit) {
      return matchingCommit;
    }
  }
  return SourceVersion.findOne({
    orgId: input.orgId,
    projectId: projectObjectId,
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ createdAt: -1, _id: -1 })
    .select({ _id: 1 })
    .lean()
    .exec();
}

// --- from sources/sources.routes.js ---
/**
 * Source version HTTP routes under `/api/v1` (list + project_knowledge_rebuild).
 */
const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});

const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

/**
 * GET /knowledge/sources/listVersions/:projectId — list source versions for a project.
 * @param {import('fastify').FastifyRequest} request Fastify request.
 * @returns {Promise<object>} Paginated source version list.
 */
export async function listProjectSourceVersionsHttp(request) {
  const params = projectIdParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  const parsed = listQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  if (parsed.data.limit === 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'limit', message: 'limit must be a positive integer' }],
    });
  }
  return listProjectSourceVersions(request.projectScope.orgId, request.projectScope.projectId, parsed.data);
}

/**
 * POST /knowledge/sources/reingest/:projectId/:sourceVersionId — enqueue a knowledge rebuild for a version.
 * @param {import('fastify').FastifyRequest} request Fastify request.
 * @param {import('fastify').FastifyReply} reply Fastify reply.
 * @returns {Promise<object>} 202 payload with job id.
 */
export async function reingestSourceHttp(request, reply) {
  const result = await enqueueSourceReingest({
    orgId: request.projectScope.orgId,
    projectId: request.projectScope.projectId,
    sourceVersionId: String(request.params.sourceVersionId),
    actorUserId: request.projectScope.userId,
    correlationId: request.id,
  });
  return reply.code(202).send(result);
}

export const SOURCE_MODELS = Object.freeze([SourceVersion, SourceFile, SourceChangeSummary]);
