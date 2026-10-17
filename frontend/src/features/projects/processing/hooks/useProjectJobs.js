/**
 * Infinite keyset list of jobs for one project.
 */
import { isActiveJobStatus } from '../jobProgressMap.js';
import { useInfiniteQuery } from '@tanstack/react-query';
import { JOB_DETAIL_POLL_INTERVAL_MS, JOB_LIST_PAGE_SIZE, listProjectJobs, projectJobsQueryKey } from '../api/jobsApi.js';

/**
 * Lists jobs for a project. Polls while any job is in flight, and while the list
 * is still empty (repo attach may enqueue sync after the first fetch).
 * @param {string | undefined | null} projectId Project id.
 * @param {{
 *   jobStatus?: string,
 *   limit?: number,
 *   enabled?: boolean,
 * }} [options] List options.
 * @returns Infinite query result for jobs.
 */
export function useProjectJobs(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;
  const queryFilters = {
    jobStatus: options.jobStatus,
  };

  return useInfiniteQuery({
    queryKey: projectJobsQueryKey(id || 'missing', queryFilters),
    queryFn: ({ pageParam, signal }) =>
      listProjectJobs({
        projectId: id,
        cursor: pageParam,
        limit: options.limit ?? JOB_LIST_PAGE_SIZE,
        jobStatus: options.jobStatus,
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
    refetchInterval: (query) => {
      const pages = query.state.data?.pages;
      if (!Array.isArray(pages)) {
        return JOB_DETAIL_POLL_INTERVAL_MS;
      }
      const items = pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
      // Keep polling while empty: repo attach schedules sync asynchronously, so the first
      // fetch can miss the job and would otherwise never refresh.
      if (items.length === 0) {
        return JOB_DETAIL_POLL_INTERVAL_MS;
      }
      const hasActive = items.some((job) => isActiveJobStatus(job.jobStatus));
      return hasActive ? JOB_DETAIL_POLL_INTERVAL_MS : false;
    },
  });
}

/**
 * Flattens infinite-query job pages into a single array.
 * @param {{ pages?: Array<{ items?: object[] }> } | undefined} data Infinite query data.
 * @returns {object[]}
 */
export function flattenJobPages(data) {
  if (!data?.pages) {
    return [];
  }
  return data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
}
