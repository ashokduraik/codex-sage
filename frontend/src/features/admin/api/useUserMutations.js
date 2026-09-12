import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  activateUser,
  createUser,
  deactivateUser,
  patchUser,
  removeUser,
  resetUserPassword,
} from './adminIdentityApi.js';
import { ADMIN_USERS_QUERY_ROOT } from './adminKeys.js';

/**
 * Optimistically patches a user inside every cached users list page.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {string} userId Target user id.
 * @param {(user: object) => object} updater Mapper for the matching row.
 * @returns {Array<[unknown, unknown]>} Previous cache entries for rollback.
 */
function patchCachedUsers(queryClient, userId, updater) {
  const previous = queryClient.getQueriesData({ queryKey: ADMIN_USERS_QUERY_ROOT });
  queryClient.setQueriesData({ queryKey: ADMIN_USERS_QUERY_ROOT }, (page) => {
    if (!Array.isArray(page?.items)) {
      return page;
    }
    return {
      ...page,
      items: page.items.map((user) =>
        String(user.id) === String(userId) ? updater(user) : user,
      ),
    };
  });
  return previous;
}

/**
 * Restores users list caches after a failed optimistic update.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {Array<[unknown, unknown]>} previous Snapshot from `patchCachedUsers`.
 */
function restoreCachedUsers(queryClient, previous) {
  for (const [key, data] of previous) {
    queryClient.setQueryData(key, data);
  }
}

/**
 * Invalidates every admin users list query.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 */
function invalidateUsersLists(queryClient) {
  return queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_ROOT });
}

/**
 * Create-user mutation. Does not write the password or optimistic list insert.
 * @returns Create mutation.
 */
export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{
     *   email: string,
     *   displayName: string,
     *   roleIds: string[],
     *   idempotencyKey: string,
     * }} input Create payload.
     */
    mutationFn: (input) => createUser(input),
    onSuccess: () => invalidateUsersLists(queryClient),
  });
}

/**
 * Role-change mutation with optimistic update and rollback.
 * @returns Role update mutation.
 */
export function useUpdateUserRoles() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{
     *   userId: string,
     *   roleIds: string[],
     *   roles: Array<{ id: string, name: string, isBuiltIn?: boolean }>,
     * }} input Role replacement.
     */
    mutationFn: ({ userId, roleIds }) => patchUser(userId, { roleIds }),
    onMutate: async ({ userId, roleIds, roles }) => {
      await queryClient.cancelQueries({ queryKey: ADMIN_USERS_QUERY_ROOT });
      const previous = patchCachedUsers(queryClient, userId, (user) => ({
        ...user,
        roles,
        roleIds,
      }));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      restoreCachedUsers(queryClient, context?.previous ?? []);
    },
    onSettled: () => invalidateUsersLists(queryClient),
  });
}

/**
 * Activate / deactivate with optimistic status and rollback.
 * @returns Status mutation.
 */
export function useSetUserStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{ userId: string, action: 'activate' | 'deactivate' }} input Status change.
     */
    mutationFn: ({ userId, action }) =>
      action === 'activate' ? activateUser(userId) : deactivateUser(userId),
    onMutate: async ({ userId, action }) => {
      await queryClient.cancelQueries({ queryKey: ADMIN_USERS_QUERY_ROOT });
      const nextStatus = action === 'activate' ? 'active' : 'disabled';
      const previous = patchCachedUsers(queryClient, userId, (user) => ({
        ...user,
        userStatus: nextStatus,
      }));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      restoreCachedUsers(queryClient, context?.previous ?? []);
    },
    onSettled: () => invalidateUsersLists(queryClient),
  });
}

/**
 * Soft-remove mutation; waits for the server before list refresh.
 * @returns Remove mutation.
 */
export function useRemoveUser() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{ userId: string }} input Target user.
     */
    mutationFn: ({ userId }) => removeUser(userId),
    onSuccess: () => invalidateUsersLists(queryClient),
  });
}

/**
 * Admin-initiated password set. Never caches `newPassword`.
 * @returns Password reset mutation.
 */
export function useResetUserPassword() {
  return useMutation({
    /**
     * @param {{ userId: string, newPassword: string, idempotencyKey: string }} input
     */
    mutationFn: ({ userId, newPassword, idempotencyKey }) =>
      resetUserPassword(userId, { newPassword, idempotencyKey }),
  });
}
