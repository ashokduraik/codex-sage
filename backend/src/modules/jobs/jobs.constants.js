/**
 * Named constants for the jobs module (not env).
 */

/** Default page size for GET /projects/:projectId/jobs. */
export const JOB_LIST_PAGE_SIZE_DEFAULT = 20;

/** Hard cap on the `limit` query parameter. */
export const JOB_LIST_PAGE_SIZE_MAX = 100;

/** Maximum stored JobEvent.message length (reject over, never truncate). */
export const JOB_EVENT_MESSAGE_MAX_LENGTH = 500;

/**
 * Default maxAttempts copied onto new jobs.
 * Phase 21 worker imports this rather than introducing an env var.
 */
export const JOB_DEFAULT_MAX_ATTEMPTS = 5;

/** Lifecycle values for `jobStatus` (not row `status`). */
export const JOB_STATUS_VALUES = Object.freeze([
  'pending',
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
  'retrying',
  'cancelled',
]);

/** First job types; more may be added by later phases. */
export const JOB_TYPE_VALUES = Object.freeze([
  'ingest',
  'reingest',
  'repo_sync',
  /** Phase 21 verification handler; domain handlers replace real work later. */
  'worker_smoke',
]);

/** Failure classification for retry policy (Phase 21/22). */
export const FAILURE_CLASS_VALUES = Object.freeze([
  'temporary',
  'permanent',
  'user_action_required',
]);

/** JobEvent severity levels. */
export const JOB_EVENT_SEVERITY_VALUES = Object.freeze(['info', 'warning', 'error']);

/** Event code written by createPendingJob. */
export const JOB_EVENT_CODE_ENQUEUED = 'job.enqueued';

/** User-facing enqueue message (no ids/stacks). */
export const JOB_ENQUEUED_MESSAGE = 'Processing is queued.';
