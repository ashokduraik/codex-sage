/**
 * Worker timings, job-event codes/messages, and per-job child loggers.
 */

/** Delay between claim attempts when idle. */
export const WORKER_POLL_INTERVAL_MS = 2000;

/** In-flight jobs per worker process. */
export const WORKER_MAX_CONCURRENT_JOBS = 2;

/** Lease refresh cadence while jobs run. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;

/** Lease lifetime; must exceed the heartbeat interval. */
export const WORKER_LEASE_TTL_MS = 60_000;

/** Expired-lease scan cadence. */
export const WORKER_SWEEP_INTERVAL_MS = 30_000;

/** Default attempt ceiling when a handler sets none. */
export const WORKER_MAX_ATTEMPTS = 5;

/** First temporary-failure backoff delay. */
export const WORKER_RETRY_BACKOFF_BASE_MS = 5000;

/** Backoff ceiling for temporary failures. */
export const WORKER_RETRY_BACKOFF_MAX_MS = 300_000;

/** Requeue delay when the project writer lock is held. */
export const WORKER_PROJECT_BUSY_RETRY_MS = 15_000;

/** Shutdown wait before releasing in-flight leases. */
export const WORKER_DRAIN_TIMEOUT_MS = 30_000;

/** Lock scope covering knowledge-build / repo-pull writers. */
export const PROJECT_JOB_LOCK_SCOPE = 'project_writer';

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

/**
 * Asserts lease TTL is strictly greater than the heartbeat interval.
 * @param {number} leaseTtlMs Lease lifetime.
 * @param {number} heartbeatIntervalMs Heartbeat cadence.
 * @throws {Error} When the combination is unsafe.
 */
export function assertLeaseExceedsHeartbeat(leaseTtlMs, heartbeatIntervalMs) {
  if (leaseTtlMs <= heartbeatIntervalMs) {
    throw new Error(`WORKER_LEASE_TTL_MS (${leaseTtlMs}) must exceed ` + `WORKER_HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs})`);
  }
}

/**
 * Asserts the configured worker lease timing is safe.
 * @throws {Error} When the combination is unsafe.
 */
export function assertWorkerLeaseTimingSafe() {
  assertLeaseExceedsHeartbeat(WORKER_LEASE_TTL_MS, WORKER_HEARTBEAT_INTERVAL_MS);
}

/**
 * Builds bindings for a job-scoped child logger.
 * @param {{
 *   workerId: string,
 *   jobId: string,
 *   jobType: string,
 *   orgId: string,
 *   projectId: string,
 *   attempt: number,
 *   stage?: string | null,
 *   correlationId?: string | null,
 * }} fields Job context fields.
 * @returns {Record<string, unknown>}
 */
export function buildJobLogBindings(fields) {
  return {
    workerId: fields.workerId,
    jobId: fields.jobId,
    jobType: fields.jobType,
    orgId: fields.orgId,
    projectId: fields.projectId,
    attempt: fields.attempt,
    stage: fields.stage ?? null,
    correlationId: fields.correlationId ?? null,
  };
}

/**
 * Creates a child logger for one in-flight job.
 * @param {object} parentLog Parent logger (pino or test double).
 * @param {Parameters<typeof buildJobLogBindings>[0]} fields Job bindings.
 * @returns {object} Child logger.
 */
export function createJobLogger(parentLog, fields) {
  const bindings = buildJobLogBindings(fields);
  if (parentLog && typeof parentLog.child === 'function') {
    return parentLog.child(bindings);
  }
  return {
    bindings,
    debug: (obj, msg) => parentLog?.debug?.({ ...bindings, ...(obj ?? {}) }, msg),
    info: (obj, msg) => parentLog?.info?.({ ...bindings, ...(obj ?? {}) }, msg),
    warn: (obj, msg) => parentLog?.warn?.({ ...bindings, ...(obj ?? {}) }, msg),
    error: (obj, msg) => parentLog?.error?.({ ...bindings, ...(obj ?? {}) }, msg),
  };
}
