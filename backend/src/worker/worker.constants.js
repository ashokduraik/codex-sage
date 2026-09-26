/**
 * Named worker timings and concurrency (not env — see env-config.mdc).
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

/** Lock scope covering ingest / reingest / repo_sync writers. */
export const PROJECT_JOB_LOCK_SCOPE = 'project_writer';

/**
 * Asserts lease TTL is strictly greater than the heartbeat interval.
 * A TTL at or below the heartbeat silently steals leases from healthy workers.
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
