/**
 * Project job list, detail, retry, and cancel HTTP calls (Phase 20 / 22).
 */
import { apiRequest } from '@/shared/api';

/** Default page size for GET /projects/:projectId/jobs. */
export const JOB_LIST_PAGE_SIZE = 20;

/** Poll interval for an in-flight job detail (until a job SSE exists). */
export const JOB_DETAIL_POLL_INTERVAL_MS = 3000;

/**
 * Builds a query string from defined filter values.
 * @param {Record<string, string | number | boolean | undefined | null>} params Query map.
 * @returns {string} Path suffix starting with `?`, or empty string.
 */
function toQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * Builds the project jobs list query key.
 * @param {string} projectId Project id.
 * @param {{ jobStatus?: string }} [filters] Optional list filters.
 * @returns {readonly unknown[]}
 */
export function projectJobsQueryKey(projectId, filters = {}) {
  return Object.freeze([
    'projects',
    String(projectId),
    'jobs',
    { jobStatus: filters.jobStatus ?? null },
  ]);
}

/**
 * Builds the job detail query key.
 * @param {string} jobId Job id.
 * @returns {readonly unknown[]}
 */
export function jobDetailQueryKey(jobId) {
  return Object.freeze(['jobs', 'detail', String(jobId)]);
}

/** Prefix that invalidates every jobs list query for a project. */
export function projectJobsQueryRoot(projectId) {
  return Object.freeze(['projects', String(projectId), 'jobs']);
}

/**
 * Lists jobs for a project (keyset pagination).
 * @param {{
 *   projectId: string,
 *   cursor?: string,
 *   limit?: number,
 *   jobStatus?: string,
 *   signal?: AbortSignal,
 * }} options List options.
 * @returns {Promise<import('./jobTypes.js').JobListPage>}
 */
export async function listProjectJobs(options) {
  const query = toQueryString({
    cursor: options.cursor,
    limit: options.limit ?? JOB_LIST_PAGE_SIZE,
    jobStatus: options.jobStatus,
  });
  return apiRequest(`/projects/${encodeURIComponent(options.projectId)}/jobs${query}`, {
    signal: options.signal,
  });
}

/**
 * Loads one job including flattened progress and events.
 * @param {string} jobId Job id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<import('./jobTypes.js').JobDetail>}
 */
export async function getJob(jobId, options = {}) {
  return apiRequest(`/jobs/${encodeURIComponent(jobId)}`, { signal: options.signal });
}

/**
 * Retries a failed or cancelled job (Idempotency-Key required).
 * @param {{
 *   jobId: string,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 * }} input Retry inputs.
 * @returns {Promise<import('./jobTypes.js').JobRetryResult>}
 */
export async function retryJob(input) {
  return apiRequest(`/jobs/${encodeURIComponent(input.jobId)}/retry`, {
    method: 'POST',
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
  });
}

/**
 * Requests cancel for a pending/retrying/running job.
 * @param {{
 *   jobId: string,
 *   signal?: AbortSignal,
 * }} input Cancel inputs.
 * @returns {Promise<import('./jobTypes.js').JobCancelResult>}
 */
export async function cancelJob(input) {
  return apiRequest(`/jobs/${encodeURIComponent(input.jobId)}/cancel`, {
    method: 'POST',
    signal: input.signal,
  });
}
