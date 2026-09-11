/**
 * User repository — every call requires orgId.
 */
import { assertOrgId, softDelete } from '../../platform/data/index.js';
import { User } from './user.model.js';

/**
 * Finds an active user by org and email.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} email Email (lowercased/trimmed for lookup).
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findUserByEmail(orgId, email, options = {}) {
  assertOrgId(orgId);
  const query = User.findOne({
    orgId,
    email: String(email).toLowerCase().trim(),
  });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Finds an active user by org and id.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findUserById(orgId, userId, options = {}) {
  assertOrgId(orgId);
  const query = User.findOne({ _id: userId, orgId });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Creates a user in an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   email: string,
 *   displayName: string,
 *   userStatus?: string,
 *   createdBy?: import('mongoose').Types.ObjectId | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 * }} input User fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createUser(orgId, input, options = {}) {
  assertOrgId(orgId);
  const [doc] = await User.create(
    [
      {
        orgId,
        email: input.email,
        displayName: input.displayName,
        userStatus: input.userStatus ?? 'invited',
        createdBy: input.createdBy ?? null,
        updatedBy: input.updatedBy ?? null,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return doc;
}

/**
 * Lists active users in an organization, newest `_id` first (keyset-ready).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{ limit?: number, beforeId?: import('mongoose').Types.ObjectId | string }} [options]
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listUsers(orgId, options = {}) {
  assertOrgId(orgId);
  const limit = options.limit ?? 50;
  const filter = { orgId };
  if (options.beforeId) {
    filter._id = { $lt: options.beforeId };
  }
  return User.find(filter).sort({ _id: -1 }).limit(limit).exec();
}

/**
 * Soft-deletes an active user within an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ updatedBy?: import('mongoose').Types.ObjectId | null }} [options] Actor stamp.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteUser(orgId, userId, options = {}) {
  assertOrgId(orgId);
  return softDelete(
    User,
    { _id: userId, orgId },
    { updatedBy: options.updatedBy ?? null },
  );
}
