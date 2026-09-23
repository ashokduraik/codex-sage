/**
 * Tenant-scoped persistence for repository connections and credentials.
 */
import mongoose from 'mongoose';
import {
  assertOrgId,
  ROW_STATUS_ACTIVE,
  ROW_STATUS_DELETED,
} from '../../platform/data/index.js';
import { RepositoryConnection } from './repositoryConnection.model.js';
import { RepositoryCredential } from './repositoryCredential.model.js';

/**
 * Finds the active connection for a project.
 * @param {string | import('mongoose').Types.ObjectId} orgId Tenant id.
 * @param {string | import('mongoose').Types.ObjectId} projectId Project id.
 * @returns {Promise<object | null>}
 */
export async function findActiveConnection(orgId, projectId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(String(projectId))) {
    return null;
  }
  return RepositoryConnection.findOne({
    orgId,
    projectId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Finds an active credential by id.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   credentialId: string | import('mongoose').Types.ObjectId,
 * }} input Scope.
 * @returns {Promise<object | null>}
 */
export async function findActiveCredential(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(String(input.credentialId))) {
    return null;
  }
  return RepositoryCredential.findOne({
    _id: input.credentialId,
    orgId: input.orgId,
    projectId: input.projectId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Inserts a connection row.
 * @param {object} fields Connection fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function insertConnection(fields, options = {}) {
  assertOrgId(fields.orgId);
  const doc = new RepositoryConnection(fields);
  if (options.session) {
    await doc.save({ session: options.session });
  } else {
    await doc.save();
  }
  return doc;
}

/**
 * Inserts a credential row.
 * @param {object} fields Credential fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function insertCredential(fields, options = {}) {
  assertOrgId(fields.orgId);
  const doc = new RepositoryCredential(fields);
  if (options.session) {
    await doc.save({ session: options.session });
  } else {
    await doc.save();
  }
  return doc;
}

/**
 * Points a connection at a credential and optional probe metadata.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   connectionId: string | import('mongoose').Types.ObjectId,
 *   set: Record<string, unknown>,
 * }} input Update.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<object | null>}
 */
export async function updateConnection(input, options = {}) {
  assertOrgId(input.orgId);
  const query = RepositoryConnection.findOneAndUpdate(
    { _id: input.connectionId, orgId: input.orgId, status: ROW_STATUS_ACTIVE },
    { $set: { ...input.set, updatedAt: new Date() } },
    { returnDocument: 'after', lean: true },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Soft-deletes the active connection and its active credentials.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   connectionId: string | import('mongoose').Types.ObjectId,
 * }} input Scope.
 * @returns {Promise<void>}
 */
export async function softDeleteConnectionAndCredentials(input) {
  assertOrgId(input.orgId);
  const now = new Date();
  await RepositoryConnection.updateOne(
    {
      _id: input.connectionId,
      orgId: input.orgId,
      projectId: input.projectId,
      status: ROW_STATUS_ACTIVE,
    },
    { $set: { status: ROW_STATUS_DELETED, updatedAt: now } },
  ).exec();
  await RepositoryCredential.updateMany(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      status: ROW_STATUS_ACTIVE,
    },
    { $set: { status: ROW_STATUS_DELETED, revokedAt: now, updatedAt: now } },
  ).exec();
}

/**
 * Soft-deletes one credential row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   credentialId: string | import('mongoose').Types.ObjectId,
 * }} input Scope.
 * @returns {Promise<void>}
 */
export async function softDeleteCredential(input) {
  assertOrgId(input.orgId);
  await RepositoryCredential.updateOne(
    {
      _id: input.credentialId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        status: ROW_STATUS_DELETED,
        revokedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  ).exec();
}
