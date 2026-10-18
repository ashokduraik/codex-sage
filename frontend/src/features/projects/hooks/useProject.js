/**
 * Project detail query.
 */
import { useQuery } from '@tanstack/react-query';
import { getProject, projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';

/** Poll while ingest/rebuild may still change lifecycle or knowledge health. */
export const PROJECT_DETAIL_POLL_INTERVAL_MS = 3000;

/** Lifecycles where a knowledge job may still update the project document. */
const PROJECT_DETAIL_POLL_LIFECYCLES = new Set(['connecting_repository', 'source_received', 'processing', 'updating']);

/**
 * Loads one project by id.
 * Polls while lifecycle is in-flight so Overview picks up post-finalize fields without a manual refresh.
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
    refetchInterval: (query) => {
      const lifecycleStatus = query.state.data?.lifecycleStatus;
      return PROJECT_DETAIL_POLL_LIFECYCLES.has(lifecycleStatus) ? PROJECT_DETAIL_POLL_INTERVAL_MS : false;
    },
  });
}
