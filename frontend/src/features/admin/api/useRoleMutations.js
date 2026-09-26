/**
 * Admin role create / update / delete mutations.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ADMIN_ROLES_QUERY_KEY, createRole, patchRole, removeRole } from './adminIdentityApi.js';

/**
 * Invalidates the aggregated roles list.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 */
function invalidateRoles(queryClient) {
  return queryClient.invalidateQueries({ queryKey: ADMIN_ROLES_QUERY_KEY });
}

/**
 * Create-role mutation.
 * @returns Create mutation.
 */
export function useCreateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{
     *   code: string,
     *   name: string,
     *   description?: string,
     *   permissions: string[],
     * }} input Create payload.
     */
    mutationFn: (input) => createRole(input),
    onSuccess: () => invalidateRoles(queryClient),
  });
}

/**
 * Update-role mutation.
 * @returns Update mutation.
 */
export function useUpdateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{
     *   roleId: string,
     *   name?: string,
     *   description?: string,
     *   permissions?: string[],
     * }} input Patch payload.
     */
    mutationFn: ({ roleId, ...patch }) => patchRole(roleId, patch),
    onSuccess: () => invalidateRoles(queryClient),
  });
}

/**
 * Soft-delete role mutation.
 * @returns Delete mutation.
 */
export function useDeleteRole() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{ roleId: string }} input Target role.
     */
    mutationFn: ({ roleId }) => removeRole(roleId),
    onSuccess: () => invalidateRoles(queryClient),
  });
}
