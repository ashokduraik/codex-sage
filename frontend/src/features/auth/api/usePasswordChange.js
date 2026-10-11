import { setAccessToken } from '@/shared/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { changePassword as changePasswordRequest, logout as logoutRequest } from './authApi.js';

/**
 * Mutation that changes the password then clears the local session (re-auth required).
 * @returns Password-change mutation result.
 */
export function usePasswordChange() {
  const queryClient = useQueryClient();

  return useMutation({
    /**
     * @param {{ currentPassword: string, newPassword: string }} input Passwords.
     */
    mutationFn: async ({ currentPassword, newPassword }) => {
      const result = await changePasswordRequest(currentPassword, newPassword);
      try {
        await logoutRequest();
      } catch {
        // Sessions already revoked server-side; clear cookies best-effort.
      } finally {
        setAccessToken(null);
        await queryClient.cancelQueries();
        queryClient.clear();
      }
      return result;
    },
  });
}
