/**
 * Mutation that fills project.description from the root README via the API LLM.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fillProjectDescriptionFromReadme, projectDetailQueryKey, PROJECTS_LIST_QUERY_ROOT } from '@/features/projects/api/projectsApi.js';

/**
 * Overwrites the project description from README (user-initiated).
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useFillProjectDescriptionFromReadme() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['projects', 'fillDescriptionFromReadme'],
    /**
     * @param {{ projectId: string }} input Fill inputs.
     */
    mutationFn: (input) => fillProjectDescriptionFromReadme(input.projectId),
    onSuccess: (data, variables) => {
      queryClient.setQueryData(projectDetailQueryKey(variables.projectId), data);
      void queryClient.invalidateQueries({ queryKey: PROJECTS_LIST_QUERY_ROOT });
      void queryClient.invalidateQueries({
        queryKey: projectDetailQueryKey(variables.projectId),
      });
    },
  });
}
