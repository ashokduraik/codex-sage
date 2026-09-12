/**
 * Ingest progress counters — honest counts only; no estimated percentages.
 */

/** Files reconciled per batch before a progress flush. */
export const INGEST_FILE_BATCH_SIZE = 250;

/** Minimum interval between counter writes to the job row. */
export const INGEST_PROGRESS_FLUSH_MS = 2000;

/**
 * @typedef {{
 *   filesTotal: number,
 *   filesProcessed: number,
 *   filesFailed: number,
 *   filesExcluded: number,
 *   bytesProcessed: number,
 *   excludedByReason: Record<string, number>,
 * }} IngestCounters
 */

/**
 * Creates a zeroed counter bag.
 * @returns {IngestCounters}
 */
export function createIngestCounters() {
  return {
    filesTotal: 0,
    filesProcessed: 0,
    filesFailed: 0,
    filesExcluded: 0,
    bytesProcessed: 0,
    excludedByReason: {},
  };
}

/**
 * Maps ingest counters onto the Job.progressCounters schema fields.
 * @param {IngestCounters} counters Domain counters.
 * @returns {{
 *   itemsProcessed: number,
 *   itemsFailed: number,
 *   warningCount: number,
 *   excludedCount: number,
 * }}
 */
export function toJobProgressCounters(counters) {
  return {
    itemsProcessed: counters.filesProcessed,
    itemsFailed: counters.filesFailed,
    warningCount: counters.filesFailed > 0 ? 1 : 0,
    excludedCount: counters.filesExcluded,
  };
}

/**
 * True when the job finished with some failed files but otherwise succeeded.
 * @param {IngestCounters} counters Domain counters.
 * @param {boolean} otherwiseCompleted Pipeline completed past implemented stages.
 * @returns {boolean}
 */
export function derivePartialSuccess(counters, otherwiseCompleted) {
  return otherwiseCompleted === true && counters.filesFailed > 0;
}

/**
 * Creates a throttled progress flusher bound to saveProgress.
 * @param {{
 *   counters: IngestCounters,
 *   saveProgress: (payload: object) => Promise<void>,
 *   getCurrentStage?: () => string | null,
 *   now?: () => number,
 *   flushIntervalMs?: number,
 * }} options Flush options.
 * @returns {{
 *   noteFileProcessed: () => void,
 *   maybeFlush: (force?: boolean) => Promise<void>,
 *   flushNow: () => Promise<void>,
 * }}
 */
export function createProgressFlusher(options) {
  const flushIntervalMs = options.flushIntervalMs ?? INGEST_PROGRESS_FLUSH_MS;
  const now = options.now ?? Date.now;
  let lastFlushAt = 0;
  let sinceFlush = 0;

  /**
   * Increments the batch counter used for flush batching.
   */
  function noteFileProcessed() {
    sinceFlush += 1;
  }

  /**
   * Writes counters when forced, at stage boundaries, or after interval/batch.
   * @param {boolean} [force] Always write.
   * @returns {Promise<void>}
   */
  async function maybeFlush(force = false) {
    const elapsed = now() - lastFlushAt;
    const batchReady = sinceFlush >= INGEST_FILE_BATCH_SIZE;
    const intervalReady = elapsed >= flushIntervalMs && sinceFlush > 0;
    if (!force && !batchReady && !intervalReady) {
      return;
    }
    await flushNow();
  }

  /**
   * Always writes counters and resets the batch window.
   * @returns {Promise<void>}
   */
  async function flushNow() {
    const payload = {
      ...toJobProgressCounters(options.counters),
      partialSuccess: options.counters.filesFailed > 0,
    };
    if (typeof options.getCurrentStage === 'function') {
      payload.currentStage = options.getCurrentStage();
    }
    await options.saveProgress(payload);
    lastFlushAt = now();
    sinceFlush = 0;
  }

  return { noteFileProcessed, maybeFlush, flushNow };
}
