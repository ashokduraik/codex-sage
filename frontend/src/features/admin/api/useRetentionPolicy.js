/**
 * React Query hooks for org retention policy GET/PATCH.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADMIN_RETENTION_POLICY_QUERY_KEY, fetchRetentionPolicy, updateRetentionPolicy } from './retentionApi.js';

/**
 * Loads the effective retention policy when the caller may manage the org.
 * @param {{ enabled?: boolean }} [options] When false, skips the request.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useRetentionPolicy(options = {}) {
  const enabled = options.enabled !== false;
  return useQuery({
    queryKey: ADMIN_RETENTION_POLICY_QUERY_KEY,
    queryFn: ({ signal }) => fetchRetentionPolicy({ signal }),
    enabled,
  });
}

/**
 * Saves a retention policy patch and refreshes the cached policy.
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useUpdateRetentionPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateRetentionPolicy,
    onSuccess: (data) => {
      queryClient.setQueryData(ADMIN_RETENTION_POLICY_QUERY_KEY, data);
    },
  });
}
