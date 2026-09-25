/**
 * User lifecycle service — create, list, get, update, activate, deactivate, remove.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { getPasswordResetStatus } from '../auth/password.service.js';
import { revokeAllSessionsForUser } from '../auth/session.repository.js';
import { bumpProjectAclVersion } from '../projectMembers/projectAclCache.js';
import {
  assertRolesExistInOrg,
  wouldRemoveLastAdmin,
} from './membership.service.js';
import {
  createMembership,
  findMembership,
  replaceMembershipRoleIds,
  softDeleteMembership,
} from './membership.repository.js';
import { findRolesByIds } from './role.repository.js';
import { isDuplicateKeyError } from './role.repository.js';
import {
  createUser as createUserInRepo,
  findUserById,
  listUsers as listUsersInRepo,
  softDeleteUser,
  updateUser,
} from './user.repository.js';

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
 * Loads membership roles for a user (empty array when no membership).
 * @param {string} orgId Tenant id.
 * @param {string} userId User id.
 * @returns {Promise<import('mongoose').Document[]>}
 */
async function loadRolesForUser(orgId, userId) {
  const membership = await findMembership(orgId, userId);
  if (!membership) {
    return [];
  }
  return findRolesByIds(
    orgId,
    membership.roleIds.map((id) => String(id)),
  );
}

/**
 * Creates an invited user with membership roles.
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

  const mongoSession = await mongoose.startSession();
  try {
    /** @type {import('mongoose').Document | undefined} */
    let createdUser;
    await mongoSession.withTransaction(async () => {
      try {
        createdUser = await createUserInRepo(
          input.orgId,
          {
            email: input.email,
            displayName: input.displayName,
            userStatus: 'invited',
            createdBy: input.actorUserId,
            updatedBy: input.actorUserId,
          },
          { session: mongoSession },
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw ApiError.fromCode('IDENTITY_DUPLICATE_EMAIL');
        }
        throw err;
      }
      await createMembership(
        input.orgId,
        {
          userId: createdUser._id,
          roleIds,
          createdBy: input.actorUserId,
          updatedBy: input.actorUserId,
        },
        { session: mongoSession },
      );
    });
    if (!createdUser) {
      throw ApiError.fromCode('INTERNAL_ERROR');
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
  } finally {
    await mongoSession.endSession();
  }
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
    const roles = await loadRolesForUser(orgId, String(user._id));
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
  const roles = await loadRolesForUser(orgId, userId);
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
  const user = await findUserById(input.orgId, input.targetUserId);
  if (!user) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }

  const previousEmail = user.email;

  if (input.roleIds) {
    const membership = await findMembership(input.orgId, input.targetUserId);
    const previousRoleIds = membership
      ? membership.roleIds.map((id) => String(id))
      : [];
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
    if (!membership) {
      throw ApiError.fromCode('NOT_FOUND', { message: 'Membership not found.' });
    }
    await replaceMembershipRoleIds(input.orgId, input.targetUserId, nextRoleIds, {
      updatedBy: input.actorUserId,
    });
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

  // Reload roles after possible replace (membership already updated).
  const roles = input.roleIds
    ? await findRolesByIds(input.orgId, input.roleIds.map(String))
    : await loadRolesForUser(input.orgId, input.targetUserId);

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
  const roles = await loadRolesForUser(input.orgId, input.targetUserId);
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
  const roles = await loadRolesForUser(input.orgId, input.targetUserId);
  return mapUserToDto(updated, roles);
}

/**
 * Soft-removes a user and tombstones membership; revokes sessions.
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
      await softDeleteMembership(input.orgId, input.targetUserId, {
        updatedBy: input.actorUserId,
        session: mongoSession,
      });
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
