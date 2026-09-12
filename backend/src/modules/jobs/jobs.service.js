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
import { mapJobToDetailDto, mapJobToListDto } from './jobs.types.js';

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
 * @returns {Promise<{ jobId: string, eventId: string }>}
 */
export async function createPendingJob(input) {
  const { job, event } = await insertPendingJob(input);
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
