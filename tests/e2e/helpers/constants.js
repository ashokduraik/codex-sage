/** Default Playwright test timeout (ms). */
export const E2E_TEST_TIMEOUT_MS = 180_000;

/** Default Playwright expect timeout (ms). */
export const E2E_EXPECT_TIMEOUT_MS = 10_000;

/** Max wait for ingest / repo-sync to reach a terminal health or job state. */
export const E2E_INGEST_WAIT_TIMEOUT_MS = 300_000;

/** Poll interval while waiting for ingest (ms). */
export const E2E_INGEST_POLL_INTERVAL_MS = 5_000;

/** Unique token embedded in the sample ZIP so search can find it. */
export const E2E_FIXTURE_SEARCH_TOKEN = 'codexSageE2eHello';
