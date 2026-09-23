/**
 * Named constants for repository sync (not env).
 */

/** Default cadence per active connection. */
export const REPO_SYNC_INTERVAL_MS = 1_800_000;

/** How often the worker scans due connections. */
export const REPO_SYNC_SCHEDULER_TICK_MS = 60_000;

/** Defer when a project writer or overlapping job is active. */
export const REPO_SYNC_OVERLAP_RETRY_MS = 120_000;

/** Wall clock for remote HEAD + archive download. */
export const REPO_SYNC_FETCH_TIMEOUT_MS = 600_000;

/** Job types that block a concurrent repo_sync persist. */
export const REPO_SYNC_OVERLAP_JOB_TYPES = Object.freeze(['ingest', 'reingest', 'repo_sync']);

/** GitHub hosts allowed after an api.github.com zipball redirect. */
export const GITHUB_ARCHIVE_REDIRECT_HOSTS = Object.freeze(['codeload.github.com']);
