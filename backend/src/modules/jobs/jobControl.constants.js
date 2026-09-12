/**
 * Named constants for job control (not env).
 */

/** How long a cancel request may wait for the worker before a sweeper may finish it. */
export const JOB_CANCEL_GRACE_MS = 60_000;

/** Ceiling on user-initiated retries per job (distinct from worker attempt). */
export const JOB_MAX_USER_RETRIES = 10;

/** Job statuses that count as an active writer for duplicate-click protection. */
export const ACTIVE_JOB_STATUSES = Object.freeze(['pending', 'retrying', 'running']);
