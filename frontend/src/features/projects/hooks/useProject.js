/**
 * Project detail query.
 */
import { useQuery } from '@tanstack/react-query';
import { getProject, projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';

/**
 * Loads one project by id.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns Detail query result.
 */
export function useProject(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;

  return useQuery({
    queryKey: projectDetailQueryKey(id || 'missing'),
    queryFn: ({ signal }) => getProject(id, { signal }),
    enabled,
  });
}
