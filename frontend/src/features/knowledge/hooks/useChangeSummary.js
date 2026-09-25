/**
 * Latest change-summary query (404 is empty).
 */
import { useQuery } from '@tanstack/react-query';
import { changeSummaryQueryKey, fetchChangeSummary } from '../api/knowledgeApi.js';

/**
 * Loads GET /knowledge/updates/latest.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useChangeSummary(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;
  return useQuery({
    queryKey: changeSummaryQueryKey(id || 'missing'),
    queryFn: ({ signal }) => fetchChangeSummary(id, { signal }),
    enabled,
  });
}
