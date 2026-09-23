/**
 * Infinite keyset list of source versions for one project.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  SOURCE_VERSION_LIST_PAGE_SIZE,
  listProjectSourceVersions,
  sourceVersionsQueryKey,
} from '@/features/projects/api/sourcesApi.js';

/**
 * Lists source versions for a project.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean, limit?: number }} [options] Query options.
 * @returns Infinite query result.
 */
export function useSourceVersions(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;

  return useInfiniteQuery({
    queryKey: sourceVersionsQueryKey(id || 'missing'),
    queryFn: ({ pageParam, signal }) =>
      listProjectSourceVersions({
        projectId: id,
        cursor: pageParam,
        limit: options.limit ?? SOURCE_VERSION_LIST_PAGE_SIZE,
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
 * Flattens infinite-query source-version pages.
 * @param {{ pages?: Array<{ items?: object[] }> } | undefined} data Infinite query data.
 * @returns {object[]}
 */
export function flattenSourceVersionPages(data) {
  if (!data?.pages) {
    return [];
  }
  return data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
}
