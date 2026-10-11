/**
 * Job detail query with polling while the job is in flight.
 */
import { useQuery } from '@tanstack/react-query';
import { isActiveJobStatus } from '../jobProgressMap.js';
import { getJob, JOB_DETAIL_POLL_INTERVAL_MS, jobDetailQueryKey } from '../api/jobsApi.js';

/**
 * Loads one job by id and polls while pending/retrying/running.
 * @param {string | undefined | null} jobId Job id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns Detail query result.
 */
export function useJob(jobId, options = {}) {
  const id = jobId ? String(jobId) : '';
  const enabled = Boolean(id) && options.enabled !== false;

  return useQuery({
    queryKey: jobDetailQueryKey(id || 'missing'),
    queryFn: ({ signal }) => getJob(id, { signal }),
    enabled,
    refetchInterval: (query) => {
      const jobStatus = query.state.data?.jobStatus;
      return isActiveJobStatus(jobStatus) ? JOB_DETAIL_POLL_INTERVAL_MS : false;
    },
  });
}
