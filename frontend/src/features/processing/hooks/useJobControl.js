/**
 * Retry and cancel mutations for a project job.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cancelJob, jobDetailQueryKey, projectJobsQueryRoot, retryJob } from '../api/jobsApi.js';

/**
 * Retry / cancel a job and invalidate list + detail caches.
 * @param {string | undefined | null} projectId Project id for list invalidation.
 * @returns {{
 *   retry: (jobId: string) => Promise<import('../api/jobTypes.js').JobRetryResult>,
 *   cancel: (jobId: string) => Promise<import('../api/jobTypes.js').JobCancelResult>,
 *   isRetrying: boolean,
 *   isCancelling: boolean,
 *   retryError: unknown,
 *   cancelError: unknown,
 *   reset: () => void,
 * }}
 */
export function useJobControl(projectId) {
  const queryClient = useQueryClient();
  const projectKey = projectId ? String(projectId) : '';

  /**
   * Invalidates job list and optional detail after a control action.
   * @param {string} jobId Job id.
   */
  function invalidateJobQueries(jobId) {
    if (projectKey) {
      void queryClient.invalidateQueries({ queryKey: projectJobsQueryRoot(projectKey) });
    }
    void queryClient.invalidateQueries({ queryKey: jobDetailQueryKey(jobId) });
  }

  const retryMutation = useMutation({
    mutationKey: ['jobs', 'retry'],
    /**
     * @param {{ jobId: string, idempotencyKey: string }} input Retry inputs.
     */
    mutationFn: (input) => retryJob(input),
    onSuccess: (_data, variables) => {
      invalidateJobQueries(variables.jobId);
    },
  });

  const cancelMutation = useMutation({
    mutationKey: ['jobs', 'cancel'],
    /**
     * @param {{ jobId: string }} input Cancel inputs.
     */
    mutationFn: (input) => cancelJob(input),
    onSuccess: (_data, variables) => {
      invalidateJobQueries(variables.jobId);
    },
  });

  return {
    /**
     * Retries a job with a fresh Idempotency-Key.
     * @param {string} jobId Job id.
     * @returns {Promise<import('../api/jobTypes.js').JobRetryResult>}
     */
    retry(jobId) {
      return retryMutation.mutateAsync({
        jobId: String(jobId),
        idempotencyKey: crypto.randomUUID(),
      });
    },
    /**
     * Requests cancel for a job.
     * @param {string} jobId Job id.
     * @returns {Promise<import('../api/jobTypes.js').JobCancelResult>}
     */
    cancel(jobId) {
      return cancelMutation.mutateAsync({ jobId: String(jobId) });
    },
    isRetrying: retryMutation.isPending,
    isCancelling: cancelMutation.isPending,
    retryError: retryMutation.error,
    cancelError: cancelMutation.error,
    reset() {
      retryMutation.reset();
      cancelMutation.reset();
    },
  };
}
