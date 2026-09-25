/**
 * Infinite keyset list of projects.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { listProjects, projectsListQueryKey } from '@/features/projects/api/projectsApi.js';

/**
 * Infinite projects list for the given filters.
 * @param {{
 *   q?: string,
 *   includeArchived?: boolean,
 *   sort?: 'updatedAt' | 'lastAccessedAt',
 *   limit?: number,
 *   enabled?: boolean,
 * }} [filters] List filters.
 * @returns Infinite query result for projects.
 */
export function useProjects(filters = {}) {
  const enabled = filters.enabled !== false;
  const queryFilters = {
    q: filters.q,
    includeArchived: filters.includeArchived,
    sort: filters.sort,
    limit: filters.limit,
  };

  return useInfiniteQuery({
    queryKey: projectsListQueryKey(queryFilters),
    queryFn: ({ pageParam, signal }) =>
      listProjects({
        ...queryFilters,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => {
      const nextCursor = lastPage?.pageInfo?.nextCursor;
      if (lastPage?.pageInfo?.hasMore && typeof nextCursor === 'string' && nextCursor) {
        return nextCursor;
      }
      return undefined;
    },
    enabled,
  });
}

/**
 * Flattens infinite-query pages into a single project array.
 * @param {{ pages?: Array<{ items?: object[] }> } | undefined} data Infinite query data.
 * @returns {object[]}
 */
export function flattenProjectPages(data) {
  if (!data?.pages) {
    return [];
  }
  return data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
}
