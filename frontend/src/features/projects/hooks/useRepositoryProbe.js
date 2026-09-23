/**
 * React Query mutation for repository probe. Token is never stored in mutation variables.
 */
import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { probeProjectRepository } from '@/features/projects/api/repositoriesApi.js';

/**
 * Probes a repository URL for the connect dialog.
 * @returns {{
 *   probe: (input: {
 *     projectId: string,
 *     repositoryUrl: string,
 *     accessToken?: string,
 *     signal?: AbortSignal,
 *   }) => Promise<import('../api/repositoryTypes.js').RepositoryProbeDto>,
 *   isPending: boolean,
 *   error: unknown,
 *   reset: Function,
 * }}
 */
export function useRepositoryProbe() {
  const tokenRef = useRef(/** @type {string | null} */ (null));
  const mutation = useMutation({
    mutationKey: ['projects', 'repositories', 'probe'],
    /**
     * @param {{
     *   projectId: string,
     *   repositoryUrl: string,
     *   signal?: AbortSignal,
     * }} input Safe probe inputs (no token).
     */
    mutationFn: (input) =>
      probeProjectRepository({
        projectId: input.projectId,
        repositoryUrl: input.repositoryUrl,
        accessToken: tokenRef.current ?? undefined,
        signal: input.signal,
      }),
  });

  return {
    isPending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
    /**
     * Runs probe without putting the token in React Query cache.
     * @param {{
     *   projectId: string,
     *   repositoryUrl: string,
     *   accessToken?: string,
     *   signal?: AbortSignal,
     * }} input Probe inputs.
     */
    async probe(input) {
      tokenRef.current = input.accessToken ? input.accessToken : null;
      try {
        return await mutation.mutateAsync({
          projectId: input.projectId,
          repositoryUrl: input.repositoryUrl,
          signal: input.signal,
        });
      } finally {
        tokenRef.current = null;
      }
    },
  };
}
