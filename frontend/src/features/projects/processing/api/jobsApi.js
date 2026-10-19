/**
 * Project job list, detail, retry, and cancel HTTP calls (Phase 20 / 22).
 * Job DTO shapes matching the Phase 20/22 backend (flattened progress on detail).
 */
import { apiRequest } from '@/shared/api';

/**
 * @typedef {'pending' | 'running' | 'completed' | 'completed_with_warnings' | 'failed' | 'retrying' | 'cancelled'} JobStatus
 */

/**
 * @typedef {'completed' | 'current' | 'pending' | 'failed' | 'skipped'} JobStageState
 */

/**
 * @typedef {{
 *   itemsProcessed: number,
 *   itemsFailed: number,
 *   warningCount: number,
 *   excludedCount: number,
 * }} JobProgressCounters
 */

/**
 * @typedef {{
 *   id: string,
 *   jobType: string,
 *   jobStatus: JobStatus | string,
 *   currentStage: string | null,
 *   failureClass: string | null,
 *   partialSuccess: boolean,
 *   progressCounters: JobProgressCounters,
 *   scheduledAt: string | null,
 *   createdAt: string | null,
 *   startedAt: string | null,
 *   completedAt: string | null,
 * }} JobListItem
 */

/**
 * @typedef {{
 *   eventCode: string,
 *   severity: string,
 *   message: string,
 *   data: object,
 *   createdAt: string | null,
 * }} JobEventDto
 */

/**
 * @typedef {{
 *   stage: string,
 *   label: string,
 *   state: JobStageState | string,
 *   startedAt?: string | null,
 *   endedAt?: string | null,
 *   itemsProcessed?: number,
 *   itemsFailed?: number,
 *   warningCount?: number,
 * }} JobStageDto
 */

/**
 * @typedef {{
 *   code: string,
 *   message: string,
 *   affectedCount?: number,
 *   occurredAt?: string | null,
 * }} JobIssueDto
 */

/**
 * @typedef {{
 *   available: boolean,
 *   mode: 'resume' | 'full' | null,
 *   reason: string | null,
 * }} JobRetryDto
 */

/**
 * @typedef {{
 *   requested: boolean,
 *   requestedAt: string | null,
 * }} JobCancellationDto
 */

/**
 * @typedef {JobListItem & {
 *   projectId: string,
 *   sourceVersionId: string | null,
 *   stageCheckpoint: object | null,
 *   correlationId: string | null,
 *   events: JobEventDto[],
 *   durationMs: number | null,
 *   percent: number | null,
 *   itemsProcessed: number,
 *   itemsFailed: number,
 *   stages: JobStageDto[],
 *   warnings: JobIssueDto[],
 *   errors: JobIssueDto[],
 *   retry: JobRetryDto,
 *   cancellation: JobCancellationDto,
 *   knowledgeAvailability: 'paused' | 'queued' | 'available' | string,
 * }} JobDetail
 */

/**
 * @typedef {{
 *   items: JobListItem[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }} JobListPage
 */

/**
 * @typedef {{
 *   jobId: string,
 *   jobStatus: string,
 *   alreadyActive?: boolean,
 *   retry?: { mode: string | null, fromStage: string | null, reason: string | null },
 * }} JobRetryResult
 */

/**
 * @typedef {{
 *   jobId: string,
 *   jobStatus: string,
 *   cancellation: JobCancellationDto,
 * }} JobCancelResult
 */

/** Default page size for GET /projects/:projectId/jobs. */
export const JOB_LIST_PAGE_SIZE = 20;

/** Poll interval for an in-flight job detail (until a job SSE exists). */
export const JOB_DETAIL_POLL_INTERVAL_MS = 3000;

/**
 * Builds the project jobs list query key.
 * @param {string} projectId Project id.
 * @param {{ jobStatus?: string }} [filters] Optional list filters.
 * @returns {readonly unknown[]}
 */
export function projectJobsQueryKey(projectId, filters = {}) {
  return Object.freeze(['projects', String(projectId), 'jobs', { jobStatus: filters.jobStatus ?? null }]);
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
 * @returns {Promise<JobListPage>}
 */
export async function listProjectJobs(options) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({
    cursor: options.cursor,
    limit: options.limit ?? JOB_LIST_PAGE_SIZE,
    jobStatus: options.jobStatus,
  })) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return apiRequest(`/masters/jobs/list/${encodeURIComponent(options.projectId)}${encoded ? `?${encoded}` : ''}`, {
    signal: options.signal,
  });
}

/**
 * Loads one job including flattened progress and events.
 * @param {string} jobId Job id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<JobDetail>}
 */
export async function getJob(jobId, options = {}) {
  return apiRequest(`/masters/jobs/get/${encodeURIComponent(jobId)}`, { signal: options.signal });
}

/**
 * Retries a failed or cancelled job (Idempotency-Key required).
 * @param {{
 *   jobId: string,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 * }} input Retry inputs.
 * @returns {Promise<JobRetryResult>}
 */
export async function retryJob(input) {
  return apiRequest('/masters/jobs/retry', {
    method: 'POST',
    body: { jobId: input.jobId },
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
 * @returns {Promise<JobCancelResult>}
 */
export async function cancelJob(input) {
  return apiRequest('/masters/jobs/cancel', {
    method: 'POST',
    body: { jobId: input.jobId },
    signal: input.signal,
  });
}
