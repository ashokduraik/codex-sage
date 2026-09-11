/**
 * Resolves role ids to an effective permission set for one organization.
 */
import { Role } from '../identity/role.model.js';
import { getBuiltInRolePermissions } from './builtInRolePermissions.js';
import { isKnownPermissionKey } from './permissionCatalog.js';
import { roleCache } from './roleCache.js';

/**
 * Loads permission keys for one role document (built-in from code, custom from DB).
 * @param {{ isBuiltIn?: boolean, builtInKey?: string | null, permissions?: string[] }} role Role doc.
 * @returns {string[]}
 */
function permissionsForRoleDocument(role) {
  if (role.isBuiltIn && role.builtInKey) {
    const fromCode = getBuiltInRolePermissions(role.builtInKey);
    if (fromCode) {
      return [...fromCode];
    }
  }
  const stored = Array.isArray(role.permissions) ? role.permissions : [];
  return stored.filter((key) => typeof key === 'string' && isKnownPermissionKey(key));
}

/**
 * Resolves effective permissions for role ids scoped to an organization.
 * Role ids that do not match an active role in the org contribute nothing.
 * @param {string} orgId Tenant id from the principal (never from the client).
 * @param {string[]} roleIds Role id strings.
 * @param {{ cache?: typeof roleCache }} [options] Optional cache override for tests.
 * @returns {Promise<string[]>} Deduplicated permission keys.
 */
export async function resolveEffectivePermissions(orgId, roleIds, options = {}) {
  const cache = options.cache ?? roleCache;
  if (!orgId || !Array.isArray(roleIds) || roleIds.length === 0) {
    return [];
  }

  const uniqueRoleIds = [...new Set(roleIds.map(String).filter(Boolean))];
  /** @type {string[]} */
  const collected = [];
  /** @type {string[]} */
  const missingIds = [];

  for (const roleId of uniqueRoleIds) {
    const cached = cache.get(orgId, roleId);
    if (cached) {
      collected.push(...cached);
    } else {
      missingIds.push(roleId);
    }
  }

  if (missingIds.length > 0) {
    const roles = await Role.find({
      _id: { $in: missingIds },
      orgId,
    }).exec();

    const foundIds = new Set(roles.map((role) => String(role._id)));
    for (const role of roles) {
      const permissions = permissionsForRoleDocument(role);
      cache.set(orgId, String(role._id), permissions);
      collected.push(...permissions);
    }
    // Cache empty arrays for unknown ids so we do not re-query within the TTL.
    for (const roleId of missingIds) {
      if (!foundIds.has(roleId)) {
        cache.set(orgId, roleId, []);
      }
    }
  }

  return [...new Set(collected)];
}

/**
 * Returns whether the effective set satisfies the required permissions.
 * @param {Iterable<string>} effective Caller permissions.
 * @param {string[]} required Required permission keys.
 * @param {'all' | 'any'} [mode] Match mode (default all).
 * @returns {boolean}
 */
export function hasRequiredPermissions(effective, required, mode = 'all') {
  const set = effective instanceof Set ? effective : new Set(effective);
  if (!required.length) {
    return false;
  }
  if (mode === 'any') {
    return required.some((key) => set.has(key));
  }
  return required.every((key) => set.has(key));
}
