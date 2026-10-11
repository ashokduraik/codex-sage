/**
 * React Query mutation for re-processing a stored source version.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';
import { projectJobsQueryRoot } from '@/features/projects/processing/api/jobsApi.js';
import { reingestProjectSource, sourceVersionsQueryKey } from '@/features/projects/api/sourcesApi.js';

/**
 * Enqueues reingest for a stored source version (same bytes, full S0–S6).
 * Invalidates the project, source-versions list, and jobs so the processing
 * center picks up the new job. Not the same as Retry (checkpoint resume).
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useReingestSource() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['projects', 'sources', 'reingest'],
    /**
     * @param {{
     *   projectId: string,
     *   sourceVersionId: string,
     *   idempotencyKey: string,
     * }} input Reingest inputs.
     */
    mutationFn: (input) => reingestProjectSource(input),
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
    },
  });
}
