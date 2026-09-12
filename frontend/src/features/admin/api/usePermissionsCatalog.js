import { useQuery } from '@tanstack/react-query';
import { fetchPermissionsCatalog } from './adminIdentityApi.js';
import { ADMIN_PERMISSIONS_QUERY_KEY } from './adminKeys.js';

/**
 * Loads the backend permission catalog (labels/groups for AdminRoles).
 * @param {{ enabled?: boolean }} [options] Enable gate (e.g. roles.manage).
 * @returns Permissions catalog query result.
 */
export function usePermissionsCatalog(options = {}) {
  return useQuery({
    queryKey: ADMIN_PERMISSIONS_QUERY_KEY,
    queryFn: ({ signal }) => fetchPermissionsCatalog({ signal }),
    enabled: options.enabled !== false,
  });
}
