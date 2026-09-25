/**
 * Membership service — atomic role replacement for a user in an organization.
 */
import { ApiError } from '../../platform/errors.js';
import { resolveEffectivePermissions } from '../authorization/permissionResolver.js';
import { recordAuditEvent } from '../audit/index.js';
import { bumpProjectAclVersion } from '../projectMembers/projectAclCache.js';
import {
  findMembership,
  listMemberships,
  replaceMembershipRoleIds,
} from './membership.repository.js';
import { findRolesByIds } from './role.repository.js';
import { findUserById } from './user.repository.js';
import { mapUserToDto } from './user.service.js';

/**
 * Returns whether the given permission set includes users.manage.
 * @param {Iterable<string>} permissions Effective permissions.
 * @returns {boolean}
 */
export function holdsUsersManage(permissions) {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  return set.has('users.manage');
}

/**
 * Counts active (userStatus=active) members who effectively hold users.manage.
 * @param {string} orgId Tenant id.
 * @param {{
 *   excludeUserId?: string,
 *   overrideRoleIdsByUserId?: Record<string, string[]>,
 * }} [options] Simulation options for a pending mutation.
 * @returns {Promise<number>}
 */
export async function countActiveUsersManageHolders(orgId, options = {}) {
  const memberships = await listMemberships(orgId);
  let count = 0;
  for (const membership of memberships) {
    const userId = String(membership.userId);
    if (options.excludeUserId && userId === String(options.excludeUserId)) {
      continue;
    }
    const user = await findUserById(orgId, membership.userId);
    if (!user || user.userStatus !== 'active') {
      continue;
    }
    const roleIds =
      options.overrideRoleIdsByUserId?.[userId] ??
      membership.roleIds.map((id) => String(id));
    const effective = await resolveEffectivePermissions(orgId, roleIds);
    if (holdsUsersManage(effective)) {
      count += 1;
    }
  }
  return count;
}

/**
 * True when applying the mutation would leave zero active users.manage holders.
 * @param {string} orgId Tenant id.
 * @param {{
 *   targetUserId: string,
 *   nextRoleIds?: string[] | null,
 *   removingOrDisabling?: boolean,
 * }} input Mutation shape.
 * @returns {Promise<boolean>}
 */
export async function wouldRemoveLastAdmin(orgId, input) {
  const target = await findUserById(orgId, input.targetUserId);
  if (!target) {
    return false;
  }

  const memberships = await listMemberships(orgId);
  const membership = memberships.find(
    (row) => String(row.userId) === String(input.targetUserId),
  );
  const currentRoleIds = membership
    ? membership.roleIds.map((id) => String(id))
    : [];
  const currentEffective = await resolveEffectivePermissions(orgId, currentRoleIds);
  const targetCurrentlyAdmin =
    target.userStatus === 'active' && holdsUsersManage(currentEffective);

  if (!targetCurrentlyAdmin) {
    return false;
  }

  if (input.removingOrDisabling) {
    const remaining = await countActiveUsersManageHolders(orgId, {
      excludeUserId: input.targetUserId,
    });
    return remaining === 0;
  }

  if (input.nextRoleIds) {
    const nextEffective = await resolveEffectivePermissions(orgId, input.nextRoleIds);
    if (holdsUsersManage(nextEffective)) {
      return false;
    }
    const remaining = await countActiveUsersManageHolders(orgId, {
      excludeUserId: input.targetUserId,
    });
    return remaining === 0;
  }

  return false;
}

/**
 * Loads roles for a membership; throws NOT_FOUND when any id is missing/cross-tenant.
 * @param {string} orgId Tenant id.
 * @param {string[]} roleIds Role ids.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function assertRolesExistInOrg(orgId, roleIds, options = {}) {
  const unique = [...new Set(roleIds.map(String))];
  const roles = await findRolesByIds(orgId, unique, options);
  if (roles.length !== unique.length) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Role not found.' });
  }
  return roles;
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
  const membership = await findMembership(input.orgId, input.targetUserId);
  if (!membership) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Membership not found.' });
  }

  const previousRoleIds = membership.roleIds.map((id) => String(id));
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
  const updated = await replaceMembershipRoleIds(
    input.orgId,
    input.targetUserId,
    nextRoleIds,
    { updatedBy: input.actorUserId },
  );
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Membership not found.' });
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

  return mapUserToDto(user, roles);
}
