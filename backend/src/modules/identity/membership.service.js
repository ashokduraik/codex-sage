/**
 * Membership service — atomic role replacement for a user in an organization.
 */
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { bumpProjectAclVersion } from '../projectMembers/bumpProjectAclVersion.js';
import { mapUserToDto } from './identity.mappers.js';
import { wouldRemoveLastAdmin } from './lastAdminGuard.js';
import {
  findMembership,
  replaceMembershipRoleIds,
} from './membership.repository.js';
import { findRolesByIds } from './role.repository.js';
import { findUserById } from './user.repository.js';

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
