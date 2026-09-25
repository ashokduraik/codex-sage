/**
 * masters/users.js — merged resource file.
 */
import { User } from '../../models/user.model.js';
import { assertOrgId, decodeCursor, encodeCursor, softDelete } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import {
  adminSetPassword,
  buildAuditContextFromRequest,
  getPasswordResetStatus,
  PASSWORD_MIN_LENGTH,
  recordAuditEvent,
  revokeAllSessionsForUser,
} from '../access/index.js';
import { z } from 'zod';
import {
  assertRolesExistInOrg,
  wouldRemoveLastAdmin,
} from './users.helper.js';
import { bumpProjectAclVersion } from './projectMembers.js';
import { findRolesByIds, isDuplicateKeyError } from './roles.js';
import mongoose from 'mongoose';

export {
  assertRolesExistInOrg,
  countActiveUsersManageHolders,
  holdsUsersManage,
  isRoleReferencedByActiveUser,
  wouldRemoveLastAdmin,
} from './users.helper.js';

// --- from identity/user.repository.js ---
/**
 * User repository — every call requires orgId (except global email login lookup).
 */
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
 *   roleIds: Array<import('mongoose').Types.ObjectId | string>,
 *   projectAccessMode?: 'all' | 'selected' | 'none',
 *   createdBy?: import('mongoose').Types.ObjectId | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 * }} input User fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createUserInRepo(orgId, input, options = {}) {
  assertOrgId(orgId);
  /** @type {Record<string, unknown>} */
  const doc = {
    orgId,
    email: input.email,
    displayName: input.displayName,
    userStatus: input.userStatus ?? 'invited',
    roleIds: input.roleIds,
    createdBy: input.createdBy ?? null,
    updatedBy: input.updatedBy ?? null,
  };
  if (input.projectAccessMode !== undefined) {
    doc.projectAccessMode = input.projectAccessMode;
  }
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
 *   roleIds?: Array<import('mongoose').Types.ObjectId | string>,
 *   projectAccessMode?: 'all' | 'selected' | 'none',
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
  if (patch.roleIds !== undefined) {
    $set.roleIds = patch.roleIds;
  }
  if (patch.projectAccessMode !== undefined) {
    $set.projectAccessMode = patch.projectAccessMode;
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
export async function listUsersInRepo(orgId, filters = {}) {
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
    query.roleIds = filters.roleId;
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

// --- from identity/user.service.js ---
/**
 * User lifecycle service — create, list, get, update, activate, deactivate, remove.
 */
/** Keys that must never appear on identity response DTOs. */
const FORBIDDEN_RESPONSE_KEYS = Object.freeze([
  'passwordHash',
  'password',
  'newPassword',
  'refreshToken',
  'refreshTokenHash',
  'token',
  'resetToken',
  'passwordResetToken',
]);

/**
 * Returns whether a plain object contains a forbidden credential-shaped key.
 * @param {unknown} value Candidate object.
 * @returns {boolean}
 */
export function containsForbiddenSecretKey(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_RESPONSE_KEYS.includes(key)) {
        return true;
      }
      if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }
  return false;
}

/**
 * Maps a user document plus role docs to the admin user DTO.
 * @param {object} user User document.
 * @param {object[]} roles Role documents (org-scoped).
 * @returns {object}
 */
export function mapUserToDto(user, roles = []) {
  const reset = getPasswordResetStatus(user);
  return {
    id: String(user._id ?? user.id),
    email: user.email,
    displayName: user.displayName,
    userStatus: user.userStatus,
    roles: roles.map((role) => ({
      id: String(role._id ?? role.id),
      name: role.name,
      isBuiltIn: Boolean(role.isBuiltIn),
    })),
    lastLoginAt:
      user.lastLoginAt instanceof Date ? user.lastLoginAt.toISOString() : null,
    passwordResetStatus: reset.state,
    passwordResetCompletedAt: reset.completedAt,
    createdAt:
      user.createdAt instanceof Date
        ? user.createdAt.toISOString()
        : String(user.createdAt ?? ''),
  };
}

/**
 * Loads role documents for a user's roleIds (empty when none).
 * @param {string} orgId Tenant id.
 * @param {{ roleIds?: Array<import('mongoose').Types.ObjectId | string> }} user User doc.
 * @returns {Promise<import('mongoose').Document[]>}
 */
async function loadRolesForUser(orgId, user) {
  const roleIds = (user.roleIds ?? []).map((id) => String(id));
  if (roleIds.length === 0) {
    return [];
  }
  return findRolesByIds(orgId, roleIds);
}

/**
 * Creates an invited user with org roles.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   email: string,
 *   displayName: string,
 *   roleIds: string[],
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Create inputs.
 * @returns {Promise<object>} User DTO.
 */
export async function createUser(input) {
  const roleIds = [...new Set(input.roleIds.map(String))];
  const roles = await assertRolesExistInOrg(input.orgId, roleIds);

  /** @type {import('mongoose').Document} */
  let createdUser;
  try {
    createdUser = await createUserInRepo(input.orgId, {
      email: input.email,
      displayName: input.displayName,
      userStatus: 'invited',
      roleIds,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw ApiError.fromCode('IDENTITY_DUPLICATE_EMAIL');
    }
    throw err;
  }

  await bumpProjectAclVersion(input.orgId);

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'user.create',
      resourceType: 'user',
      resourceId: String(createdUser._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        email: createdUser.email,
        userStatus: createdUser.userStatus,
        roleIds,
      },
    },
    { log: input.log },
  );

  return mapUserToDto(createdUser, roles);
}

/**
 * Lists users with filters and keyset pagination.
 * @param {string} orgId Tenant id.
 * @param {{
 *   q?: string,
 *   userStatus?: string,
 *   roleId?: string,
 *   cursor?: string,
 *   limit?: number,
 * }} filters List filters.
 * @returns {Promise<{ items: object[], pageInfo: object }>}
 */
export async function listUsers(orgId, filters = {}) {
  const page = await listUsersInRepo(orgId, filters);
  const items = [];
  for (const user of page.items) {
    const roles = await loadRolesForUser(orgId, user);
    items.push(mapUserToDto(user, roles));
  }
  return { items, pageInfo: page.pageInfo };
}

/**
 * Returns one user DTO or throws NOT_FOUND.
 * @param {string} orgId Tenant id.
 * @param {string} userId User id.
 * @returns {Promise<object>}
 */
export async function getUser(orgId, userId) {
  const user = await findUserById(orgId, userId);
  if (!user) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }
  const roles = await loadRolesForUser(orgId, user);
  return mapUserToDto(user, roles);
}

/**
 * Patches displayName, email, and/or roleIds.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   targetUserId: string,
 *   displayName?: string,
 *   email?: string,
 *   roleIds?: string[],
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Patch inputs.
 * @returns {Promise<object>}
 */
export async function updateUserDetails(input) {
  let user = await findUserById(input.orgId, input.targetUserId);
  if (!user) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }

  const previousEmail = user.email;

  if (input.roleIds) {
    const previousRoleIds = (user.roleIds ?? []).map((id) => String(id));
    const nextRoleIds = [...new Set(input.roleIds.map(String))];
    if (
      await wouldRemoveLastAdmin(input.orgId, {
        targetUserId: input.targetUserId,
        nextRoleIds,
      })
    ) {
      throw ApiError.fromCode('LAST_ADMIN_REQUIRED');
    }
    await assertRolesExistInOrg(input.orgId, nextRoleIds);
    const rolesUpdated = await updateUser(input.orgId, input.targetUserId, {
      roleIds: nextRoleIds,
      updatedBy: input.actorUserId,
    });
    if (!rolesUpdated) {
      throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
    }
    user = rolesUpdated;
    await bumpProjectAclVersion(input.orgId);
    await recordAuditEvent(
      {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        action: 'user.roles_changed',
        resourceType: 'user',
        resourceId: String(input.targetUserId),
        result: 'success',
        correlationId: input.correlationId,
        ip: input.ip,
        userAgent: input.userAgent,
        context: { previousRoleIds, nextRoleIds },
      },
      { log: input.log },
    );
  }

  const emailChanged =
    input.email !== undefined &&
    String(input.email).toLowerCase().trim() !== String(previousEmail).toLowerCase();

  /** @type {import('mongoose').Document | null} */
  let updated = user;
  if (input.displayName !== undefined || input.email !== undefined) {
    try {
      updated = await updateUser(
        input.orgId,
        input.targetUserId,
        {
          displayName: input.displayName,
          email: input.email,
          updatedBy: input.actorUserId,
        },
      );
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw ApiError.fromCode('IDENTITY_DUPLICATE_EMAIL');
      }
      throw err;
    }
    if (!updated) {
      throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
    }
  }

  if (emailChanged && updated) {
    await revokeAllSessionsForUser(input.orgId, input.targetUserId, 'email_changed');
    await recordAuditEvent(
      {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        action: 'user.email_changed',
        resourceType: 'user',
        resourceId: String(input.targetUserId),
        result: 'success',
        correlationId: input.correlationId,
        ip: input.ip,
        userAgent: input.userAgent,
        context: {
          previousEmail,
          nextEmail: updated.email,
        },
      },
      { log: input.log },
    );
  } else if (input.displayName !== undefined || input.email !== undefined) {
    await recordAuditEvent(
      {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        action: 'user.update',
        resourceType: 'user',
        resourceId: String(input.targetUserId),
        result: 'success',
        correlationId: input.correlationId,
        ip: input.ip,
        userAgent: input.userAgent,
        context: {
          displayName: updated?.displayName,
        },
      },
      { log: input.log },
    );
  }

  const roles = input.roleIds
    ? await findRolesByIds(input.orgId, input.roleIds.map(String))
    : await loadRolesForUser(input.orgId, updated ?? user);

  return mapUserToDto(updated ?? user, roles);
}

/**
 * Activates a user (userStatus → active).
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   targetUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Activate inputs.
 * @returns {Promise<object>}
 */
export async function activateUser(input) {
  const user = await findUserById(input.orgId, input.targetUserId);
  if (!user) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }
  const previousStatus = user.userStatus;
  const updated = await updateUser(
    input.orgId,
    input.targetUserId,
    { userStatus: 'active', updatedBy: input.actorUserId },
  );
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'user.activate',
      resourceType: 'user',
      resourceId: String(input.targetUserId),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { previousStatus, nextStatus: 'active' },
    },
    { log: input.log },
  );
  const roles = await loadRolesForUser(input.orgId, updated);
  return mapUserToDto(updated, roles);
}

/**
 * Deactivates a user (userStatus → disabled).
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   targetUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Deactivate inputs.
 * @returns {Promise<object>}
 */
export async function deactivateUser(input) {
  if (String(input.actorUserId) === String(input.targetUserId)) {
    throw ApiError.fromCode('CANNOT_MODIFY_SELF');
  }
  const user = await findUserById(input.orgId, input.targetUserId);
  if (!user) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }
  if (
    await wouldRemoveLastAdmin(input.orgId, {
      targetUserId: input.targetUserId,
      removingOrDisabling: true,
    })
  ) {
    throw ApiError.fromCode('LAST_ADMIN_REQUIRED');
  }
  const previousStatus = user.userStatus;
  const updated = await updateUser(
    input.orgId,
    input.targetUserId,
    { userStatus: 'disabled', updatedBy: input.actorUserId },
  );
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }
  await revokeAllSessionsForUser(input.orgId, input.targetUserId, 'user_disabled');
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'user.deactivate',
      resourceType: 'user',
      resourceId: String(input.targetUserId),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { previousStatus, nextStatus: 'disabled' },
    },
    { log: input.log },
  );
  const roles = await loadRolesForUser(input.orgId, updated);
  return mapUserToDto(updated, roles);
}

/**
 * Soft-removes a user and revokes sessions.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   targetUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Remove inputs.
 * @returns {Promise<void>}
 */
export async function removeUser(input) {
  if (String(input.actorUserId) === String(input.targetUserId)) {
    throw ApiError.fromCode('CANNOT_MODIFY_SELF');
  }
  const user = await findUserById(input.orgId, input.targetUserId);
  if (!user) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }
  if (
    await wouldRemoveLastAdmin(input.orgId, {
      targetUserId: input.targetUserId,
      removingOrDisabling: true,
    })
  ) {
    throw ApiError.fromCode('LAST_ADMIN_REQUIRED');
  }

  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await softDeleteUser(input.orgId, input.targetUserId, {
        updatedBy: input.actorUserId,
        session: mongoSession,
      });
      await revokeAllSessionsForUser(
        input.orgId,
        input.targetUserId,
        'user_disabled',
        { session: mongoSession },
      );
    });
  } finally {
    await mongoSession.endSession();
  }

  await bumpProjectAclVersion(input.orgId);

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'user.remove',
      resourceType: 'user',
      resourceId: String(input.targetUserId),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { previousStatus: user.userStatus },
    },
    { log: input.log },
  );
}

/**
 * Replaces a user's organization role set.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   targetUserId: string,
 *   roleIds: string[],
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Replace inputs.
 * @returns {Promise<object>} Updated user DTO.
 */
export async function replaceUserRoles(input) {
  const user = await findUserById(input.orgId, input.targetUserId);
  if (!user) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }

  const previousRoleIds = (user.roleIds ?? []).map((id) => String(id));
  const nextRoleIds = [...new Set(input.roleIds.map(String))];

  if (
    await wouldRemoveLastAdmin(input.orgId, {
      targetUserId: input.targetUserId,
      nextRoleIds,
    })
  ) {
    throw ApiError.fromCode('LAST_ADMIN_REQUIRED');
  }

  const roles = await assertRolesExistInOrg(input.orgId, nextRoleIds);
  const updated = await updateUser(input.orgId, input.targetUserId, {
    roleIds: nextRoleIds,
    updatedBy: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }

  await bumpProjectAclVersion(input.orgId);

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'user.roles_changed',
      resourceType: 'user',
      resourceId: String(input.targetUserId),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { previousRoleIds, nextRoleIds },
    },
    { log: input.log },
  );

  return mapUserToDto(updated, roles);
}

const objectIdStringSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'must be a 24-char hex ObjectId');

const roleIdsSchema = z.array(objectIdStringSchema).min(1);

const createUserBodySchema = z
  .object({
    email: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(120),
    roleIds: roleIdsSchema,
  })
  .strict();

const patchUserBodySchema = z
  .object({
    email: z.string().email().max(320).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    roleIds: roleIdsSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.email !== undefined ||
      body.displayName !== undefined ||
      body.roleIds !== undefined,
    { message: 'at least one of email, displayName, roleIds is required' },
  );

const replaceRolesBodySchema = z.object({ roleIds: roleIdsSchema }).strict();

const listUsersQuerySchema = z
  .object({
    q: z.string().min(1).max(200).optional(),
    userStatus: z.enum(['active', 'invited', 'disabled']).optional(),
    roleId: objectIdStringSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

const userIdParamsSchema = z.object({ userId: objectIdStringSchema });

const resetBodySchema = z.object({ newPassword: z.string().min(1).max(1024) }).strict();

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}

/**
 * Shared request context for identity services.
 * @param {import('fastify').FastifyRequest} request Request.
 */
function serviceContext(request) {
  const audit = buildAuditContextFromRequest(request);
  return {
    orgId: /** @type {string} */ (request.principal.orgId),
    actorUserId: /** @type {string} */ (request.principal.userId),
    correlationId: audit.correlationId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    log: request.log,
  };
}

/**
 * Registers user admin routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function userRoutes(app) {
  app.post(
    '/users',
    { config: { requiredPermissions: ['users.manage'], requireIdempotencyKey: true } },
    async (request, reply) => {
      const parsed = createUserBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      const user = await createUser({
        ...ctx,
        email: parsed.data.email,
        displayName: parsed.data.displayName,
        roleIds: parsed.data.roleIds,
      });
      return reply.code(201).send(user);
    },
  );

  app.get(
    '/users',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const parsed = listUsersQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listUsers(request.principal.orgId, parsed.data);
    },
  );

  app.get(
    '/users/:userId',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      return getUser(request.principal.orgId, params.data.userId);
    },
  );

  app.patch(
    '/users/:userId',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = patchUserBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      return updateUserDetails({
        ...ctx,
        targetUserId: params.data.userId,
        displayName: parsed.data.displayName,
        email: parsed.data.email,
        roleIds: parsed.data.roleIds,
      });
    },
  );

  app.post(
    '/users/:userId/activate',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      return activateUser({ ...ctx, targetUserId: params.data.userId });
    },
  );

  app.post(
    '/users/:userId/deactivate',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      return deactivateUser({ ...ctx, targetUserId: params.data.userId });
    },
  );

  app.delete(
    '/users/:userId',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request, reply) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      await removeUser({ ...ctx, targetUserId: params.data.userId });
      return reply.code(204).send();
    },
  );

  app.put(
    '/users/:userId/roles',
    { config: { requiredPermissions: ['users.manage', 'roles.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = replaceRolesBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      return replaceUserRoles({
        ...ctx,
        targetUserId: params.data.userId,
        roleIds: parsed.data.roleIds,
      });
    },
  );

  app.post(
    '/users/:userId/reset-password',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = resetBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.newPassword.length < PASSWORD_MIN_LENGTH) {
        throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
          details: { violations: ['TOO_SHORT'] },
        });
      }
      const principal = request.principal;
      const auditBase = buildAuditContextFromRequest(request);
      const result = await adminSetPassword(
        {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          targetUserId: params.data.userId,
          newPassword: parsed.data.newPassword,
        },
        { log: request.log },
      );
      if (result.outcome === 'not_found') {
        throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
      }
      if (result.outcome === 'policy_violation') {
        throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
          details: { violations: result.violations ?? [] },
        });
      }
      if (result.outcome !== 'password_changed' || !result.passwordUpdatedAt) {
        throw ApiError.fromCode('INTERNAL_ERROR');
      }
      await recordAuditEvent(
        {
          ...auditBase,
          orgId: principal.orgId,
          actorUserId: principal.userId,
          action: 'user.password_set_by_admin',
          resourceType: 'user',
          resourceId: String(result.userId ?? params.data.userId),
          result: 'success',
          context: { reason: 'admin_set', sessionsRevoked: true },
        },
        { log: request.log },
      );
      return {
        userId: result.userId,
        passwordResetStatus: 'completed',
        completedAt: result.passwordUpdatedAt.toISOString(),
        sessionsRevoked: true,
        deliveryChannel: 'administrator',
      };
    },
  );
}

/** @deprecated Prefer {@link userRoutes}; kept for existing unit tests. */
export { userRoutes as adminPasswordResetRoutes };
