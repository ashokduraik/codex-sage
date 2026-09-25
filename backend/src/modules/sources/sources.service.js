/**
 * Source version HTTP use cases (reingest).
 */
import { ApiError } from '../../platform/errors.js';
import {
  createPendingJob,
  findActiveJobForSourceVersion,
} from '../jobs/index.js';
import { findActiveSourceVersionForProject, listSourceVersionsByProject } from './sources.repository.js';

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
 * Maps a SourceVersion document to the list DTO.
 * @param {object} version SourceVersion document or lean object.
 * @returns {object}
 */
export function mapSourceVersionToListDto(version) {
  const counts = version.fileCounts ?? {};
  return {
    id: String(version._id ?? version.id),
    origin: version.origin,
    versionLifecycle: version.versionLifecycle,
    fileCounts: {
      accepted: counts.accepted ?? 0,
      skipped: counts.skipped ?? 0,
      excludedFromGraph: counts.excludedFromGraph ?? 0,
    },
    jobId: version.jobId ? String(version.jobId) : null,
    commitSha: version.commitSha ?? null,
    branch: version.branch ?? null,
    createdBy: version.createdBy ? String(version.createdBy) : null,
    createdAt: toIsoOrNull(version.createdAt),
  };
}

/**
 * Lists source versions for a project (caller already passed project ACL).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ cursor?: string, limit?: unknown }} [query] List query.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listProjectSourceVersions(orgId, projectId, query = {}) {
  const result = await listSourceVersionsByProject(orgId, projectId, query);
  return {
    items: result.items.map(mapSourceVersionToListDto),
    pageInfo: result.pageInfo,
  };
}

/**
 * Enqueues a reingest job for an existing source version, or returns the active one.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   actorUserId: string,
 *   correlationId?: string | null,
 * }} input Scope and actor.
 * @returns {Promise<{ jobId: string, sourceVersionId: string, jobType: string }>}
 */
export async function enqueueSourceReingest(input) {
  const version = await findActiveSourceVersionForProject(
    input.orgId,
    input.projectId,
    input.sourceVersionId,
  );
  if (!version) {
    throw ApiError.fromCode('SOURCE_VERSION_NOT_FOUND');
  }

  const active = await findActiveJobForSourceVersion(
    input.orgId,
    input.projectId,
    input.sourceVersionId,
  );
  if (active) {
    return {
      jobId: String(active._id),
      sourceVersionId: String(version._id),
      jobType: String(active.jobType),
    };
  }

  const pending = await createPendingJob({
    orgId: input.orgId,
    projectId: input.projectId,
    jobType: 'reingest',
    createdBy: input.actorUserId,
    correlationId: input.correlationId ?? null,
    sourceVersionId: String(version._id),
  });

  return {
    jobId: pending.jobId,
    sourceVersionId: String(version._id),
    jobType: 'reingest',
  };
}
