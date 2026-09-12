/**
 * React Query keys for admin identity screens.
 */

/**
 * Builds the users list query key from filter/cursor state.
 * @param {{
 *   q?: string,
 *   userStatus?: string,
 *   roleId?: string,
 *   cursor?: string,
 *   limit?: number,
 * }} filters List filters.
 * @returns {readonly unknown[]}
 */
export function adminUsersQueryKey(filters = {}) {
  return Object.freeze([
    'admin',
    'users',
    {
      q: filters.q ?? '',
      userStatus: filters.userStatus ?? '',
      roleId: filters.roleId ?? '',
      cursor: filters.cursor ?? '',
      limit: filters.limit ?? null,
    },
  ]);
}

/** Prefix for invalidating every users list query. */
export const ADMIN_USERS_QUERY_ROOT = Object.freeze(['admin', 'users']);

/** Roles list (all pages aggregated by the hook). */
export const ADMIN_ROLES_QUERY_KEY = Object.freeze(['admin', 'roles']);

/** Permission catalog from GET /permissions. */
export const ADMIN_PERMISSIONS_QUERY_KEY = Object.freeze(['admin', 'permissions']);
