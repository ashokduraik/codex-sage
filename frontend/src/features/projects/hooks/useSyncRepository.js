/**
 * Mutation that enqueues a manual repository sync (fresh pull).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';
import { sourceVersionsQueryKey } from '@/features/projects/api/sourcesApi.js';
import { projectJobsQueryRoot } from '@/features/projects/processing/api/jobsApi.js';
import { repositoryConnectionQueryKey, syncProjectRepository } from '@/features/projects/api/repositoriesApi.js';

/**
 * Enqueues `connected_repo_pull` for the project's attached repository.
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useSyncRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['projects', 'repositories', 'sync'],
    /**
     * @param {{
     *   projectId: string,
     *   idempotencyKey: string,
     * }} input Sync inputs.
     */
    mutationFn: (input) => syncProjectRepository(input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: projectDetailQueryKey(variables.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: projectJobsQueryRoot(variables.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: sourceVersionsQueryKey(variables.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: repositoryConnectionQueryKey(variables.projectId),
      });
    },
  });
}
