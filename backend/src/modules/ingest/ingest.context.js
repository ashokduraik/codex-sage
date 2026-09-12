/**
 * IngestStageContext — single argument every ingest stage receives.
 */
import {
  createIngestCounters,
  createProgressFlusher,
  toJobProgressCounters,
} from './ingest.counters.js';

/**
 * Builds the stage context from a claimed worker context and SourceVersion.
 * Scope is taken from the job row only — never re-derived from user input.
 * @param {{
 *   workerContext: {
 *     job: object,
 *     stageCheckpoint: object | null,
 *     log: object,
 *     signal: AbortSignal,
 *     recordEvent: (event: object) => Promise<void>,
 *     saveCheckpoint: (checkpoint: object) => Promise<void>,
 *     saveProgress: (progress: object) => Promise<void>,
 *     isCancelRequested: () => Promise<boolean>,
 *   },
 *   origin: 'upload' | 'repository',
 * }} input Builder inputs.
 * @returns {object} IngestStageContext
 */
export function buildIngestStageContext(input) {
  const { workerContext, origin } = input;
  const job = workerContext.job;
  const counters = createIngestCounters();
  let currentStage = job.currentStage ?? null;

  const flusher = createProgressFlusher({
    counters,
    saveProgress: (payload) => workerContext.saveProgress(payload),
    getCurrentStage: () => currentStage,
  });

  return {
    scope: {
      orgId: String(job.orgId),
      projectId: String(job.projectId),
      sourceVersionId: job.sourceVersionId ? String(job.sourceVersionId) : null,
      jobId: String(job._id),
      correlationId: job.correlationId ?? null,
    },
    origin,
    attempt: job.attempt ?? 0,
    checkpoint: workerContext.stageCheckpoint
      ? {
          lastCompletedStage: workerContext.stageCheckpoint.lastCompletedStage ?? null,
          cursor: workerContext.stageCheckpoint.cursor,
        }
      : { lastCompletedStage: null },
    counters,
    logger: workerContext.log,
    signal: workerContext.signal,
    carry: {},
    /**
     * Emits one JobEvent via the worker runtime.
     * @param {{ eventCode: string, severity: string, message: string, data?: object }} event Event.
     * @returns {Promise<void>}
     */
    async emitEvent(event) {
      await workerContext.recordEvent(event);
    },
    /**
     * Flushes counters (throttled unless force).
     * @param {boolean} [force] Always write.
     * @returns {Promise<void>}
     */
    async saveProgress(force = false) {
      if (force) {
        await flusher.flushNow();
        return;
      }
      await flusher.maybeFlush(false);
    },
    /**
     * Notes one file for batch flush accounting.
     */
    noteFileProcessed() {
      flusher.noteFileProcessed();
    },
    /**
     * Persists a stage checkpoint and updates currentStage.
     * @param {{ lastCompletedStage: string, cursor?: unknown }} checkpoint Checkpoint.
     * @returns {Promise<void>}
     */
    async saveCheckpoint(checkpoint) {
      currentStage = checkpoint.lastCompletedStage;
      await workerContext.saveCheckpoint(checkpoint);
      await flusher.flushNow();
    },
    /**
     * Persists an intra-stage cursor without completing the stage.
     * @param {unknown} cursor Cursor payload (e.g. `{ lastPath }`).
     * @param {string} stageName Stage currently running.
     * @returns {Promise<void>}
     */
    async saveInProgressCursor(cursor, stageName) {
      currentStage = stageName;
      const lastCompleted = this.checkpoint?.lastCompletedStage ?? null;
      if (lastCompleted == null) {
        return;
      }
      await workerContext.saveCheckpoint({
        lastCompletedStage: lastCompleted,
        cursor,
        currentStage: stageName,
      });
      this.checkpoint = {
        lastCompletedStage: lastCompleted,
        cursor,
      };
    },
    /**
     * Sets the in-memory current stage (before checkpoint) for progress writes.
     * @param {string} stageName Stage id.
     */
    setCurrentStage(stageName) {
      currentStage = stageName;
    },
    /**
     * @returns {Promise<boolean>}
     */
    async isCancelRequested() {
      return workerContext.isCancelRequested();
    },
    /**
     * Snapshot of Job.progressCounters shape (tests / summary).
     * @returns {object}
     */
    jobProgressSnapshot() {
      return toJobProgressCounters(counters);
    },
  };
}
