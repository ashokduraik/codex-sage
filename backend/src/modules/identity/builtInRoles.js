/**
 * Built-in role keys and display names seeded per organization.
 * Permissions stay empty — Phase 09 resolves them from the code catalog.
 */

/** @typedef {'org_admin' | 'project_admin' | 'member' | 'viewer'} BuiltInRoleKey */

/**
 * Ordered built-in roles for every organization.
 * @type {ReadonlyArray<{ key: BuiltInRoleKey, name: string, description: string }>}
 */
export const BUILT_IN_ROLES = Object.freeze([
  Object.freeze({
    key: 'org_admin',
    name: 'Org Admin',
    description: 'Full organization administration.',
  }),
  Object.freeze({
    key: 'project_admin',
    name: 'Project Admin',
    description: 'Administer projects within the organization.',
  }),
  Object.freeze({
    key: 'member',
    name: 'Member',
    description: 'Standard member access.',
  }),
  Object.freeze({
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access.',
  }),
]);

/** Allowed built-in role keys. */
export const BUILT_IN_ROLE_KEYS = Object.freeze(BUILT_IN_ROLES.map((role) => role.key));

/**
 * Returns whether `key` is one of the four built-in role keys.
 * @param {string} key Candidate key.
 * @returns {boolean}
 */
export function isBuiltInRoleKey(key) {
  return BUILT_IN_ROLE_KEYS.includes(/** @type {BuiltInRoleKey} */ (key));
}
