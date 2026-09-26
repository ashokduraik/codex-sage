/**
 * GridFS cleanup for knowledge tests — not a production export.
 */
import mongoose from 'mongoose';
import { GRIDFS_SOURCE_BUCKET } from '../src/modules/knowledge/sources.js';

/**
 * Deletes all documents in the source GridFS bucket.
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
