/**
 * Loop-owned JobEvent codes and user-facing messages (Phase 21).
 */

export const WORKER_EVENT_CLAIMED = 'job.claimed';
export const WORKER_EVENT_PROJECT_BUSY_REQUEUED = 'job.project_busy_requeued';
export const WORKER_EVENT_INTERRUPTED_REQUEUED = 'job.interrupted_requeued';
export const WORKER_EVENT_RETRY_SCHEDULED = 'job.retry_scheduled';
export const WORKER_EVENT_FAILED_PERMANENT = 'job.failed_permanent';
export const WORKER_EVENT_FAILED_ATTEMPTS_EXHAUSTED = 'job.failed_attempts_exhausted';
export const WORKER_EVENT_RELEASED_ON_SHUTDOWN = 'job.released_on_shutdown';
export const WORKER_EVENT_COMPLETED = 'job.completed';
export const WORKER_EVENT_COMPLETED_WITH_WARNINGS = 'job.completed_with_warnings';
export const WORKER_EVENT_CANCELLED = 'job.cancelled';

export const WORKER_MSG_CLAIMED = 'Processing started.';
export const WORKER_MSG_PROJECT_BUSY = 'Another knowledge or sync update is already running on this project. This job will retry shortly.';
export const WORKER_MSG_INTERRUPTED = 'Processing was interrupted and will resume automatically.';
export const WORKER_MSG_RETRY_SCHEDULED = 'A temporary failure occurred; processing will retry automatically.';
export const WORKER_MSG_FAILED_PERMANENT = 'Processing failed and will not retry automatically.';
export const WORKER_MSG_FAILED_ATTEMPTS = 'Processing failed after the maximum number of attempts.';
export const WORKER_MSG_RELEASED_SHUTDOWN = 'The worker shut down and released this job so another worker can claim it.';
export const WORKER_MSG_COMPLETED = 'Processing completed.';
export const WORKER_MSG_COMPLETED_WARNINGS = 'Processing completed with warnings.';
export const WORKER_MSG_CANCELLED = 'Processing was cancelled.';

/** Failure code when a lease expires and attempts are exhausted. */
export const WORKER_LEASE_EXPIRED_CODE = 'WORKER_LEASE_EXPIRED';
