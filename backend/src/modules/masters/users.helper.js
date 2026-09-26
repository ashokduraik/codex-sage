/**
 * users.helper.js — last-admin, role-in-use, and role-existence checks.
 * Used only by users.js.
 */
import { User } from '../../models/user.model.js';
import { assertOrgId } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { resolveEffectivePermissions } from '../access/index.js';
import { findRolesByIds } from './roles.js';
import mongoose from 'mongoose';

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
 * Counts active (userStatus=active) users who effectively hold users.manage.
 * @param {string} orgId Tenant id.
 * @param {{
 *   excludeUserId?: string,
 *   overrideRoleIdsByUserId?: Record<string, string[]>,
 * }} [options] Simulation options for a pending mutation.
 * @returns {Promise<number>}
 */
export async function countActiveUsersManageHolders(orgId, options = {}) {
  assertOrgId(orgId);
  const users = await User.find({ orgId }).exec();
  let count = 0;
  for (const user of users) {
    const userId = String(user._id);
    if (options.excludeUserId && userId === String(options.excludeUserId)) {
      continue;
    }
    if (user.userStatus !== 'active') {
      continue;
    }
    const roleIds = options.overrideRoleIdsByUserId?.[userId] ?? (user.roleIds ?? []).map((id) => String(id));
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
  assertOrgId(orgId);
  const target = await User.findOne({ _id: input.targetUserId, orgId }).exec();
  if (!target) {
    return false;
  }

  const currentRoleIds = (target.roleIds ?? []).map((id) => String(id));
  const currentEffective = await resolveEffectivePermissions(orgId, currentRoleIds);
  const targetCurrentlyAdmin = target.userStatus === 'active' && holdsUsersManage(currentEffective);

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
 * Loads roles; throws NOT_FOUND when any id is missing/cross-tenant.
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
 * Returns whether any active user references the role.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} roleId Role id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<boolean>}
 */
export async function isRoleReferencedByActiveUser(orgId, roleId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(roleId)) {
    return false;
  }
  const query = User.findOne({ orgId, roleIds: roleId }).select({ _id: 1 });
  if (options.session) {
    query.session(options.session);
  }
  const found = await query.exec();
  return Boolean(found);
}
