/**
 * GridFS bucket helper for accepted source file bytes.
 */
import mongoose from 'mongoose';
import { GRIDFS_SOURCE_BUCKET } from './sources.constants.js';

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
  await files.updateMany(
    { _id: { $in: gridFsIds } },
    { $set: { 'metadata.orphanedAt': now } },
  );
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
  const id =
    gridFsId instanceof mongoose.Types.ObjectId
      ? gridFsId
      : new mongoose.Types.ObjectId(String(gridFsId));
  const doc = await db.collection(`${GRIDFS_SOURCE_BUCKET}.files`).findOne({ _id: id });
  if (!doc) {
    return null;
  }
  return {
    length: typeof doc.length === 'number' ? doc.length : 0,
    sha256:
      doc.metadata && typeof doc.metadata.sha256 === 'string' ? doc.metadata.sha256 : null,
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
  const id =
    gridFsId instanceof mongoose.Types.ObjectId
      ? gridFsId
      : new mongoose.Types.ObjectId(String(gridFsId));
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

/**
 * Deletes all documents in the source GridFS bucket (test cleanup only).
 * @param {import('mongoose').Connection} [connection] Connection.
 * @returns {Promise<void>}
 */
export async function clearSourceFilesBucket(connection = mongoose.connection) {
  const db = connection.db;
  if (!db) {
    return;
  }
  await db.collection(`${GRIDFS_SOURCE_BUCKET}.files`).deleteMany({});
  await db.collection(`${GRIDFS_SOURCE_BUCKET}.chunks`).deleteMany({});
}
