import { useQuery } from '@tanstack/react-query';
import { ADMIN_ROLES_QUERY_KEY, listAllRoles } from './adminIdentityApi.js';

/**
 * Loads all organization roles for pickers and the permissions matrix.
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
