/**
 * Asserts every permission string stored on active roles exists in the catalog.
 * Built-in roles store empty arrays; unknown custom keys fail startup.
 */
import { Role } from '../identity/role.model.js';
import { isKnownPermissionKey } from './permissionCatalog.js';

/**
 * Scans active roles for permission keys missing from the catalog.
 * @returns {Promise<void>}
 * @throws {Error} When any stored permission is unknown.
 */
export async function assertRolePermissionsInCatalog() {
  const roles = await Role.find({}).select({ permissions: 1, name: 1, orgId: 1 }).exec();
  /** @type {string[]} */
  const unknown = [];
  for (const role of roles) {
    const permissions = Array.isArray(role.permissions) ? role.permissions : [];
    for (const key of permissions) {
      if (typeof key === 'string' && key.length > 0 && !isKnownPermissionKey(key)) {
        unknown.push(`${role.orgId}/${role.name}:${key}`);
      }
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Role permission catalog drift: unknown keys ${unknown.slice(0, 20).join(', ')}`,
    );
  }
}
