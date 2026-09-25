import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { adminUsersQueryKey, listUsers } from './adminIdentityApi.js';

/**
 * Lists admin users for the given filters/cursor (filters belong in the query key).
 * @param {{
 *   q?: string,
 *   userStatus?: string,
 *   roleId?: string,
 *   cursor?: string,
 *   limit?: number,
 *   enabled?: boolean,
 * }} filters List filters from the URL (already debounced for `q`).
 * @returns Users list query result.
 */
export function useUsers(filters = {}) {
  const enabled = filters.enabled !== false;
  const queryFilters = {
    q: filters.q,
    userStatus: filters.userStatus,
    roleId: filters.roleId,
    cursor: filters.cursor,
    limit: filters.limit,
  };

  return useQuery({
    queryKey: adminUsersQueryKey(queryFilters),
    queryFn: ({ signal }) => listUsers({ ...queryFilters, signal }),
    enabled,
    placeholderData: keepPreviousData,
  });
}
