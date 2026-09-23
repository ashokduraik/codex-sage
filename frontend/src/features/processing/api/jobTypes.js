/**
 * Job DTO shapes matching the Phase 20/22 backend (flattened progress on detail).
 */

/** Job statuses that still poll. */
export const ACTIVE_JOB_STATUSES = Object.freeze(['pending', 'retrying', 'running']);

/** Job statuses shown in processing history. */
export const HISTORY_JOB_STATUSES = Object.freeze([
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
]);

/** Known job types from the backend catalog. */
export const JOB_TYPE_VALUES = Object.freeze([
  'ingest',
  'reingest',
  'repo_sync',
  'worker_smoke',
]);

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
