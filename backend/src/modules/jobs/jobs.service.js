/**
 * Jobs service — enqueue helper and project-scoped read use cases.
 */
import { ApiError } from '../../platform/errors.js';
import { hasRequiredPermissions } from '../authorization/permissionResolver.js';
import { resolveProjectPermissions } from '../projectMembers/projectAccess.js';
import {
  findJobById,
  insertPendingJob,
  listEventsForJob,
  listJobsByProject,
} from './jobs.repository.js';
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

/**
 * Creates a pending job and its initial enqueued event (internal; no HTTP create).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   jobType: string,
 *   createdBy?: string | null,
 *   correlationId?: string | null,
 *   sourceVersionId?: string | null,
 *   maxAttempts?: number,
 *   scheduledAt?: Date,
 * }} input Create fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<{ jobId: string, eventId: string }>}
 */
export async function createPendingJob(input, options = {}) {
  const { job, event } = await insertPendingJob(input, options);
  return {
    jobId: String(job._id),
    eventId: String(event._id),
  };
}

/**
 * Lists jobs for a project (caller already passed project ACL on the route).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ cursor?: string, limit?: unknown, jobStatus?: string }} [query] List query.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listProjectJobs(orgId, projectId, query = {}) {
  const result = await listJobsByProject(orgId, projectId, query);
  return {
    items: result.items.map(mapJobToListDto),
    pageInfo: result.pageInfo,
  };
}

/**
 * Loads a job by id with events after project ACL check.
 * Cross-tenant / no project access → JOB_NOT_FOUND (enumeration-safe).
 * @param {string} orgId Tenant id.
 * @param {string} userId Actor user id.
 * @param {string} jobId Job id.
 * @param {{ requestMemo?: Map<string, unknown> }} [options] Optional ACL request memo.
 * @returns {Promise<object>}
 */
export async function getJobById(orgId, userId, jobId, options = {}) {
  const job = await findJobById(orgId, jobId);
  if (!job) {
    throw ApiError.fromCode('JOB_NOT_FOUND');
  }

  const projectId = String(job.projectId);
  const resolved = await resolveProjectPermissions(orgId, userId, projectId, {
    requestMemo: options.requestMemo,
  });

  if (resolved.kind === 'NO_ACCESS') {
    throw ApiError.fromCode('JOB_NOT_FOUND');
  }

  if (!hasRequiredPermissions(resolved.permissions, ['projects.view'], 'all')) {
    throw ApiError.fromCode('FORBIDDEN');
  }

  const events = await listEventsForJob(orgId, jobId);
  return mapJobToDetailDto(job, events);
}
