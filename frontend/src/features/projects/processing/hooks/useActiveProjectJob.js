/**
 * Best in-flight job for a project (header chip and overview banner).
 */
import { flattenJobPages, useProjectJobs } from './useProjectJobs.js';
import { selectActiveJob } from '../jobProgressMap.js';

/**
 * Loads the project job list and picks the preferred active job.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns {{
 *   activeJob: object | null,
 *   jobs: object[],
 *   isLoading: boolean,
 *   isError: boolean,
 *   error: unknown,
 * }}
 */
export function useActiveProjectJob(projectId, options = {}) {
  const listQuery = useProjectJobs(projectId, { enabled: options.enabled });
  const jobs = flattenJobPages(listQuery.data);
  return {
    activeJob: selectActiveJob(jobs),
    jobs,
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
    error: listQuery.error,
  };
}
