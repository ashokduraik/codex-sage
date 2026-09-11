/**
 * Last-administrator invariant helpers for identity mutations.
 */
import { resolveEffectivePermissions } from '../authorization/permissionResolver.js';
import { listMemberships } from './membership.repository.js';
import { findUserById } from './user.repository.js';

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
