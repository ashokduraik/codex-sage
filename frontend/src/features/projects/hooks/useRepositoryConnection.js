/**
 * Active repository connection for a project.
 */
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/shared/api';
import { getProjectRepositoryConnection, repositoryConnectionQueryKey } from '@/features/projects/api/repositoriesApi.js';

/**
 * Loads the connection, treating 404 as "none".
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns Query result whose data is `{ connection }` or `{ connection: null }`.
 */
export function useRepositoryConnection(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;

  return useQuery({
    queryKey: repositoryConnectionQueryKey(id || 'missing'),
    queryFn: async ({ signal }) => {
      try {
        return await getProjectRepositoryConnection(id, { signal });
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND')) {
          return { connection: null };
        }
        throw error;
      }
    },
    enabled,
  });
}
