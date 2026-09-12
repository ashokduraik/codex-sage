/**
 * Job DTO helpers — list vs detail shapes for the read APIs.
 */
import { projectJobProgress } from './jobProgress.js';

/**
 * Formats a date as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

/**
 * Maps progressCounters to a plain object with numeric defaults.
 * @param {object | null | undefined} counters Stored counters.
 * @returns {{
 *   itemsProcessed: number,
 *   itemsFailed: number,
 *   warningCount: number,
 *   excludedCount: number,
 * }}
 */
function mapProgressCounters(counters) {
  return {
    itemsProcessed: counters?.itemsProcessed ?? 0,
    itemsFailed: counters?.itemsFailed ?? 0,
    warningCount: counters?.warningCount ?? 0,
    excludedCount: counters?.excludedCount ?? 0,
  };
}

/**
 * Maps stageCheckpoint for the detail response (never on list).
 * @param {object | null | undefined} checkpoint Stored checkpoint.
 * @returns {{
 *   lastCompletedStage: string | null,
 *   cursor?: unknown,
 *   updatedAt: string | null,
 * } | null}
 */
function mapStageCheckpoint(checkpoint) {
  if (checkpoint == null) {
    return null;
  }
  /** @type {{ lastCompletedStage: string | null, updatedAt: string | null, cursor?: unknown }} */
  const mapped = {
    lastCompletedStage: checkpoint.lastCompletedStage ?? null,
    updatedAt: toIsoOrNull(checkpoint.updatedAt),
  };
  if (Object.prototype.hasOwnProperty.call(checkpoint, 'cursor')) {
    mapped.cursor = checkpoint.cursor;
  }
  return mapped;
}

/**
 * Maps a JobEvent document to the API event DTO.
 * @param {object} event JobEvent document or lean object.
 * @returns {{
 *   eventCode: string,
 *   severity: string,
 *   message: string,
 *   data: object,
 *   createdAt: string | null,
 * }}
 */
export function mapJobEventToDto(event) {
  return {
    eventCode: event.eventCode,
    severity: event.severity,
    message: event.message,
    data:
      event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? { ...event.data }
        : {},
    createdAt: toIsoOrNull(event.createdAt),
  };
}

/**
 * Maps a job document to the list-item DTO (omits workerId and stageCheckpoint).
 * @param {object} job Job document or lean object.
 * @returns {object}
 */
export function mapJobToListDto(job) {
  return {
    id: String(job._id ?? job.id),
    jobType: job.jobType,
    jobStatus: job.jobStatus,
    currentStage: job.currentStage ?? null,
    failureClass: job.failureClass ?? null,
    partialSuccess: job.partialSuccess === true,
    progressCounters: mapProgressCounters(job.progressCounters),
    scheduledAt: toIsoOrNull(job.scheduledAt),
    createdAt: toIsoOrNull(job.createdAt),
    startedAt: toIsoOrNull(job.startedAt),
    completedAt: toIsoOrNull(job.completedAt),
  };
}

/**
 * Maps a job document plus events to the detail DTO.
 * Does not expose workerId (operational, not user-facing).
 * @param {object} job Job document or lean object.
 * @param {object[]} [events] Ordered JobEvent documents.
 * @returns {object}
 */
export function mapJobToDetailDto(job, events = []) {
  const progress = projectJobProgress(job, events);
  return {
    ...mapJobToListDto(job),
    projectId: String(job.projectId),
    sourceVersionId: job.sourceVersionId ? String(job.sourceVersionId) : null,
    stageCheckpoint: mapStageCheckpoint(job.stageCheckpoint),
    correlationId: job.correlationId ?? null,
    events: events.map(mapJobEventToDto),
    durationMs: progress.durationMs,
    percent: progress.percent,
    itemsProcessed: progress.itemsProcessed,
    itemsFailed: progress.itemsFailed,
    stages: progress.stages,
    warnings: progress.warnings,
    errors: progress.errors,
    retry: progress.retry,
    cancellation: progress.cancellation,
    knowledgeAvailability: progress.knowledgeAvailability,
  };
}
