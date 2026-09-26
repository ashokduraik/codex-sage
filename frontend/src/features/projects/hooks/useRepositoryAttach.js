/**
 * React Query mutation for repository attach. Token is never stored in mutation variables.
 */
import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachProjectRepository, repositoryConnectionQueryKey } from '@/features/projects/api/repositoriesApi.js';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';

/**
 * Attaches a repository and seeds the connection cache.
 * @returns {{
 *   attach: (input: {
 *     projectId: string,
 *     repositoryUrl: string,
 *     selectedBranch: string,
 *     accessToken?: string,
 *     idempotencyKey: string,
 *     signal?: AbortSignal,
 *   }) => Promise<import('../api/repositoriesApi.js').RepositoryAttachResult>,
 *   isPending: boolean,
 *   error: unknown,
 *   reset: Function,
 * }}
 */
export function useRepositoryAttach() {
  const queryClient = useQueryClient();
  const tokenRef = useRef(/** @type {string | null} */ (null));
  const mutation = useMutation({
    mutationKey: ['projects', 'repositories', 'attach'],
    /**
     * @param {{
     *   projectId: string,
     *   repositoryUrl: string,
     *   selectedBranch: string,
     *   idempotencyKey: string,
     *   signal?: AbortSignal,
     * }} input Safe attach inputs (no token).
     */
    mutationFn: (input) =>
      attachProjectRepository({
        ...input,
        accessToken: tokenRef.current ?? undefined,
      }),
    onSuccess: (data, variables) => {
      if (data?.connection) {
        queryClient.setQueryData(repositoryConnectionQueryKey(variables.projectId), data);
      }
      void queryClient.invalidateQueries({
        queryKey: projectDetailQueryKey(variables.projectId),
      });
    },
  });

  return {
    isPending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
    /**
     * Attaches without putting the token in React Query cache.
     * @param {{
     *   projectId: string,
     *   repositoryUrl: string,
     *   selectedBranch: string,
     *   accessToken?: string,
     *   idempotencyKey: string,
     *   signal?: AbortSignal,
     * }} input Attach inputs.
     */
    async attach(input) {
      tokenRef.current = input.accessToken ? input.accessToken : null;
      try {
        return await mutation.mutateAsync({
          projectId: input.projectId,
          repositoryUrl: input.repositoryUrl,
          selectedBranch: input.selectedBranch,
          idempotencyKey: input.idempotencyKey,
          signal: input.signal,
        });
      } finally {
        tokenRef.current = null;
      }
    },
  };
}
