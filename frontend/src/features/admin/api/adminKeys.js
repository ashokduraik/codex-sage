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

/**
 * Builds the audit-events infinite-query key from filter state (cursor is not in the key).
 * @param {{
 *   from?: string,
 *   to?: string,
 *   actor?: string,
 *   action?: string,
 *   resourceType?: string,
 *   limit?: number,
 * }} filters List filters.
 * @returns {readonly unknown[]}
 */
export function adminAuditEventsQueryKey(filters = {}) {
  return Object.freeze([
    'admin',
    'audit-events',
    {
      from: filters.from ?? '',
      to: filters.to ?? '',
      actor: filters.actor ?? '',
      action: filters.action ?? '',
      resourceType: filters.resourceType ?? '',
      limit: filters.limit ?? null,
    },
  ]);
}

/** Prefix for invalidating every audit-events query. */
export const ADMIN_AUDIT_EVENTS_QUERY_ROOT = Object.freeze(['admin', 'audit-events']);
