/**
 * Replace / revoke / re-test mutations for a repository connection.
 */
import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';
import {
  replaceProjectRepositoryCredential,
  repositoryConnectionQueryKey,
  retestProjectRepositoryConnection,
  revokeProjectRepositoryCredential,
} from '@/features/projects/api/repositoriesApi.js';
import { sourceVersionsQueryKey } from '@/features/projects/api/sourcesApi.js';

/**
 * Credential write actions. Token is never stored in mutation variables.
 * @param {string | undefined | null} projectId Project id.
 * @returns {{
 *   replace: (accessToken: string) => Promise<unknown>,
 *   revoke: () => Promise<void>,
 *   retest: () => Promise<unknown>,
 *   isReplacing: boolean,
 *   isRevoking: boolean,
 *   isRetesting: boolean,
 *   replaceError: unknown,
 *   revokeError: unknown,
 *   retestError: unknown,
 *   reset: () => void,
 * }}
 */
export function useRepositoryCredentialActions(projectId) {
  const queryClient = useQueryClient();
  const id = projectId ? String(projectId) : '';
  const tokenRef = useRef(/** @type {string | null} */ (null));

  /**
   * Invalidates connection, versions, and project detail.
   */
  function invalidateSourceQueries() {
    if (!id) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: repositoryConnectionQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: sourceVersionsQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: projectDetailQueryKey(id) });
  }

  const replaceMutation = useMutation({
    mutationKey: ['projects', 'repositories', 'replace'],
    mutationFn: () =>
      replaceProjectRepositoryCredential({
        projectId: id,
        accessToken: tokenRef.current ?? '',
      }),
    onSuccess: () => {
      invalidateSourceQueries();
    },
  });

  const revokeMutation = useMutation({
    mutationKey: ['projects', 'repositories', 'revoke'],
    mutationFn: () => revokeProjectRepositoryCredential({ projectId: id }),
    onSuccess: () => {
      invalidateSourceQueries();
    },
  });

  const retestMutation = useMutation({
    mutationKey: ['projects', 'repositories', 'retest'],
    mutationFn: () => retestProjectRepositoryConnection({ projectId: id }),
    onSuccess: () => {
      invalidateSourceQueries();
    },
  });

  return {
    /**
     * Replaces the stored token without caching it.
     * @param {string} accessToken New token.
     */
    async replace(accessToken) {
      tokenRef.current = accessToken;
      try {
        return await replaceMutation.mutateAsync();
      } finally {
        tokenRef.current = null;
      }
    },
    revoke() {
      return revokeMutation.mutateAsync();
    },
    retest() {
      return retestMutation.mutateAsync();
    },
    isReplacing: replaceMutation.isPending,
    isRevoking: revokeMutation.isPending,
    isRetesting: retestMutation.isPending,
    replaceError: replaceMutation.error,
    revokeError: revokeMutation.error,
    retestError: retestMutation.error,
    reset() {
      replaceMutation.reset();
      revokeMutation.reset();
      retestMutation.reset();
    },
  };
}
