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
