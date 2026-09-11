/**
 * User repository — every call requires orgId (except global email login lookup).
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
 * Finds active users by email across tenants (login resolution).
 * Includes `passwordHash` for credential verification.
 * @param {string} email Email (lowercased/trimmed).
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function findActiveUsersByEmailWithPassword(email) {
  return User.find({ email: String(email).toLowerCase().trim() })
    .select('+passwordHash')
    .exec();
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
 * Finds an active user by org and id, including passwordHash.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findUserByIdWithPassword(orgId, userId, options = {}) {
  assertOrgId(orgId);
  const query = User.findOne({ _id: userId, orgId }).select('+passwordHash');
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
 *   passwordHash?: string,
 *   passwordUpdatedAt?: Date,
 *   createdBy?: import('mongoose').Types.ObjectId | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 * }} input User fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createUser(orgId, input, options = {}) {
  assertOrgId(orgId);
  /** @type {Record<string, unknown>} */
  const doc = {
    orgId,
    email: input.email,
    displayName: input.displayName,
    userStatus: input.userStatus ?? 'invited',
    createdBy: input.createdBy ?? null,
    updatedBy: input.updatedBy ?? null,
  };
  if (input.passwordHash !== undefined) {
    doc.passwordHash = input.passwordHash;
  }
  if (input.passwordUpdatedAt !== undefined) {
    doc.passwordUpdatedAt = input.passwordUpdatedAt;
  }
  const [created] = await User.create(
    [doc],
    options.session ? { session: options.session } : undefined,
  );
  return created;
}

/**
 * Sets password hash and activates the user when a hash is missing (bootstrap).
 * Does nothing when a hash already exists (idempotent).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {string} passwordHash argon2id hash.
 * @param {{ session?: import('mongoose').ClientSession, activate?: boolean }} [options]
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function setPasswordHashIfMissing(orgId, userId, passwordHash, options = {}) {
  assertOrgId(orgId);
  const now = new Date();
  /** @type {Record<string, unknown>} */
  const $set = {
    passwordHash,
    passwordUpdatedAt: now,
    updatedAt: now,
  };
  if (options.activate !== false) {
    $set.userStatus = 'active';
  }
  const query = User.updateOne(
    {
      _id: userId,
      orgId,
      $or: [{ passwordHash: { $exists: false } }, { passwordHash: null }, { passwordHash: '' }],
    },
    { $set },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Replaces the stored password hash (rehash-on-login / password change).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {string} passwordHash New argon2id hash.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function updateUserPasswordHash(orgId, userId, passwordHash) {
  assertOrgId(orgId);
  const now = new Date();
  return User.updateOne(
    { _id: userId, orgId },
    {
      $set: {
        passwordHash,
        passwordUpdatedAt: now,
        updatedAt: now,
      },
    },
  ).exec();
}

/**
 * Records a successful login timestamp.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function touchLastLoginAt(orgId, userId) {
  assertOrgId(orgId);
  const now = new Date();
  return User.updateOne(
    { _id: userId, orgId },
    { $set: { lastLoginAt: now, updatedAt: now } },
  ).exec();
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
