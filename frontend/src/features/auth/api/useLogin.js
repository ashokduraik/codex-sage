import { useMutation, useQueryClient } from '@tanstack/react-query';
import { login as loginRequest } from './authApi.js';
import { CURRENT_USER_QUERY_KEY } from './authKeys.js';
import { fetchCurrentUser } from './authApi.js';

/**
 * Mutation that signs in and loads the current-user query.
 * @returns Login mutation result.
 */
export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    /**
     * @param {{ email: string, password: string }} input Credentials.
     */
    mutationFn: async ({ email, password }) => {
      await loginRequest(email, password);
      return queryClient.fetchQuery({
        queryKey: CURRENT_USER_QUERY_KEY,
        queryFn: ({ signal }) => fetchCurrentUser({ signal }),
      });
    },
  });
}
