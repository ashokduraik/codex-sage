/**
 * React Query hooks for organization roles (full list for pickers, paged list for the admin table).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ADMIN_ROLES_QUERY_KEY, adminRolesQueryKey, listAllRoles, listRolesPage } from './adminIdentityApi.js';

/**
 * Loads all organization roles for pickers (invite, edit-user roles).
 * @param {{ enabled?: boolean }} [options] Enable gate (e.g. roles.manage).
 * @returns Roles query result (`data` is an array of role DTOs).
 */
export function useRoles(options = {}) {
  return useQuery({
    queryKey: ADMIN_ROLES_QUERY_KEY,
    queryFn: ({ signal }) => listAllRoles({ signal }),
    enabled: options.enabled !== false,
  });
}

/**
 * Lists one page of roles for the admin summary table.
 * @param {{
 *   q?: string,
 *   cursor?: string,
 *   limit?: number,
 *   enabled?: boolean,
 * }} filters List filters from the URL (already debounced for `q`).
 * @returns Paged roles query result.
 */
export function useRolesPage(filters = {}) {
  const enabled = filters.enabled !== false;
  const queryFilters = {
    q: filters.q,
    cursor: filters.cursor,
    limit: filters.limit,
  };

  return useQuery({
    queryKey: adminRolesQueryKey(queryFilters),
    queryFn: ({ signal }) => listRolesPage({ ...queryFilters, signal }),
    enabled,
    placeholderData: keepPreviousData,
  });
}
