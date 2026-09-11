import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setAccessToken } from '@/shared/api';
import { logout as logoutRequest } from './authApi.js';

/**
 * Mutation that calls logout, clears the in-memory token (no session-cleared notify),
 * and empties the React Query cache.
 * @returns Logout mutation result.
 */
export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      try {
        await logoutRequest();
      } catch {
        // Cookie may already be gone; still clear client state.
      } finally {
        setAccessToken(null);
        await queryClient.cancelQueries();
        queryClient.clear();
      }
    },
  });
}
