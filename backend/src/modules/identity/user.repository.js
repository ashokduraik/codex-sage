/**
 * User repository — every call requires orgId (except global email login lookup).
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  assertOrgId,
  decodeCursor,
  encodeCursor,
  softDelete,
} from '../../platform/data/index.js';
import { Membership } from './membership.model.js';
import { User } from './user.model.js';

/** Default page size for admin user lists. */
export const IDENTITY_LIST_PAGE_SIZE_DEFAULT = 25;

/** Hard cap on `limit` for identity list endpoints. */
export const IDENTITY_LIST_PAGE_SIZE_MAX = 100;

/**
 * Clamps a requested identity list page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 * @throws {ApiError} When limit is present but not a positive integer.
 */
export function clampIdentityListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return IDENTITY_LIST_PAGE_SIZE_DEFAULT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'limit', message: 'limit must be a positive integer' }],
    });
  }
  return Math.min(Math.floor(parsed), IDENTITY_LIST_PAGE_SIZE_MAX);
}

/**
 * Builds a keyset filter for createdAt/_id descending pages.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @returns {object}
 */
function keysetAfterFilter(cursor) {
  const createdAt = new Date(cursor.t);
  if (Number.isNaN(createdAt.getTime())) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'cursor', message: 'cursor timestamp is invalid' }],
    });
  }
  if (!mongoose.isValidObjectId(cursor.i)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'cursor', message: 'cursor id is invalid' }],
    });
  }
  const id = new mongoose.Types.ObjectId(cursor.i);
  return {
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: id } },
    ],
  };
}

/**
 * Escapes a string for use as a literal prefix in a RegExp.
 * @param {string} value Raw input.
 * @returns {string}
 */
function escapeRegexPrefix(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * Updates mutable user fields within an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{
 *   displayName?: string,
 *   email?: string,
 *   userStatus?: string,
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 * }} patch Fields to set.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function updateUser(orgId, userId, patch, options = {}) {
  assertOrgId(orgId);
  /** @type {Record<string, unknown>} */
  const $set = { updatedAt: new Date() };
  if (patch.displayName !== undefined) {
    $set.displayName = patch.displayName;
  }
  if (patch.email !== undefined) {
    $set.email = String(patch.email).toLowerCase().trim();
  }
  if (patch.userStatus !== undefined) {
    $set.userStatus = patch.userStatus;
  }
  if (patch.updatedBy !== undefined) {
    $set.updatedBy = patch.updatedBy ?? null;
  }
  const query = User.findOneAndUpdate(
    { _id: userId, orgId },
    { $set },
    { returnDocument: 'after' },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
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
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function updateUserPasswordHash(orgId, userId, passwordHash, options = {}) {
  assertOrgId(orgId);
  const now = new Date();
  const query = User.updateOne(
    { _id: userId, orgId },
    {
      $set: {
        passwordHash,
        passwordUpdatedAt: now,
        updatedAt: now,
      },
    },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Applies a full password update (hash, timestamps, must-change flag, optional status).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{
 *   passwordHash: string,
 *   mustChangePassword: boolean,
 *   userStatus?: string,
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 * }} input Update fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<{ matched: boolean, passwordUpdatedAt: Date }>}
 */
export async function applyPasswordUpdate(orgId, userId, input, options = {}) {
  assertOrgId(orgId);
  const now = new Date();
  /** @type {Record<string, unknown>} */
  const $set = {
    passwordHash: input.passwordHash,
    passwordUpdatedAt: now,
    mustChangePassword: input.mustChangePassword,
    updatedAt: now,
    updatedBy: input.updatedBy ?? null,
  };
  if (input.userStatus !== undefined) {
    $set.userStatus = input.userStatus;
  }
  const query = User.updateOne({ _id: userId, orgId }, { $set });
  if (options.session) {
    query.session(options.session);
  }
  const result = await query.exec();
  return { matched: result.matchedCount > 0, passwordUpdatedAt: now };
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
 * Lists active users in an organization with filters and keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   q?: string,
 *   userStatus?: string,
 *   roleId?: string,
 *   cursor?: string,
 *   limit?: number,
 * }} [filters] List filters.
 * @returns {Promise<{
 *   items: import('mongoose').Document[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }>}
 */
export async function listUsers(orgId, filters = {}) {
  assertOrgId(orgId);
  const limit = clampIdentityListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = { orgId };

  if (filters.userStatus) {
    query.userStatus = filters.userStatus;
  }

  if (filters.q && String(filters.q).trim().length > 0) {
    const prefix = escapeRegexPrefix(String(filters.q).trim());
    const pattern = new RegExp(`^${prefix}`, 'i');
    query.$or = [{ email: pattern }, { displayName: pattern }];
  }

  if (filters.roleId) {
    if (!mongoose.isValidObjectId(filters.roleId)) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'roleId', message: 'roleId must be a valid ObjectId' }],
      });
    }
    const memberships = await Membership.find({
      orgId,
      roleIds: filters.roleId,
    })
      .select({ userId: 1 })
      .exec();
    const userIds = memberships.map((row) => row.userId);
    query._id = { $in: userIds };
  }

  if (filters.cursor) {
    let decoded;
    try {
      decoded = decodeCursor(filters.cursor);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CURSOR') {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'cursor', message: 'cursor is malformed' }],
        });
      }
      throw err;
    }
    const keyset = keysetAfterFilter(decoded);
    if (query.$or) {
      query.$and = [{ $or: query.$or }, keyset];
      delete query.$or;
    } else {
      Object.assign(query, { $and: [keyset] });
    }
  }

  const rows = await User.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  /** @type {string | null} */
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.createdAt.toISOString(),
      i: String(last._id),
    });
  }

  return {
    items,
    pageInfo: { nextCursor, hasMore },
  };
}

/**
 * Soft-deletes an active user within an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor stamp and session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteUser(orgId, userId, options = {}) {
  assertOrgId(orgId);
  return softDelete(
    User,
    { _id: userId, orgId },
    { updatedBy: options.updatedBy ?? null, session: options.session },
  );
}
