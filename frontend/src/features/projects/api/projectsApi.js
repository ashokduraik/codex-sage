/**
 * Projects HTTP calls and React Query keys (Phase 19).
 * DTO shapes consumed by the projects feature; runtime values may include unknown strings.
 */
import { apiRequest } from '@/shared/api';

/**
 * @typedef {'creating' | 'awaiting_source' | 'connecting_repository' | 'source_received' |
 *   'processing' | 'knowledge_ready' | 'updating' | 'failed' | 'partially_available' |
 *   'archived' | string} ProjectLifecycleStatus
 */

/**
 * @typedef {'none' | 'updating' | 'ready' | 'partially_available' | 'stale' | 'failed' | string} KnowledgeHealth
 */

/**
 * @typedef {'upload' | 'repository'} ProjectSourceType
 */

/**
 * @typedef {object} ProjectSourceConfig
 * @property {ProjectSourceType} sourceType How source is expected.
 * @property {string} [repositoryConnectionId] Connected repository id when present.
 * @property {string} [currentSourceVersionId] Current source version id when present.
 */

/**
 * @typedef {object} ProjectCounts
 * @property {number} sourceVersions Stored source version count.
 * @property {number} files Indexed file count.
 * @property {number} excludedFiles Excluded file count.
 * @property {number} conversations Conversation count.
 */

/**
 * @typedef {object} ProjectDto
 * @property {string} id Project id.
 * @property {string} name Display name.
 * @property {string} description Optional description.
 * @property {ProjectLifecycleStatus} lifecycleStatus Backend lifecycle code.
 * @property {KnowledgeHealth} knowledgeHealth Backend knowledge-health code.
 * @property {ProjectSourceConfig} sourceConfig Source configuration.
 * @property {ProjectCounts} counts Aggregate counts.
 * @property {string | null} lastAccessedAt ISO last-access stamp, or null.
 * @property {string | null} createdBy Creator user id.
 * @property {string} createdAt ISO created stamp.
 * @property {string} updatedAt ISO updated stamp.
 * @property {string | null} [archivedAt] Present on detail responses.
 * @property {string | null} [currentKnowledgeVersionId] Present on detail responses.
 * @property {Record<string, unknown>} [settings] Present on detail responses.
 * @property {string | null} [lifecycleStatusReasonCode] Present on detail responses.
 * @property {string | null} [lifecycleStatusChangedAt] Present on detail responses.
 */

/**
 * @typedef {object} ProjectListPage
 * @property {ProjectDto[]} items Page of projects.
 * @property {{ nextCursor: string | null, hasMore: boolean }} pageInfo Keyset page info.
 */

/**
 * @typedef {object} ProjectDeletionConsequence
 * @property {string} resource Affected resource key.
 * @property {string} effect Effect key (e.g. soft_deleted, retained).
 * @property {number | null} retentionDays Retention days when applicable.
 */

/**
 * @typedef {object} ProjectDeletionPreview
 * @property {{
 *   sourceVersions: number,
 *   files: number,
 *   conversations: number,
 *   jobs: number,
 * }} counts Backend-provided counts.
 * @property {ProjectDeletionConsequence[]} consequences Consequence rows.
 */

/** Default page size for project lists. */
export const PROJECTS_LIST_DEFAULT_LIMIT = 20;

/**
 * Builds the projects infinite-list query key (cursor is not part of the key).
 * @param {{
 *   q?: string,
 *   includeArchived?: boolean,
 *   sort?: 'updatedAt' | 'lastAccessedAt',
 *   limit?: number,
 * }} filters List filters.
 * @returns {readonly unknown[]}
 */
export function projectsListQueryKey(filters = {}) {
  return Object.freeze([
    'projects',
    'list',
    {
      q: filters.q ?? '',
      includeArchived: Boolean(filters.includeArchived),
      sort: filters.sort ?? 'updatedAt',
      limit: filters.limit ?? null,
    },
  ]);
}

/** Prefix for invalidating every projects list query. */
export const PROJECTS_LIST_QUERY_ROOT = Object.freeze(['projects', 'list']);

/**
 * Builds the project detail query key.
 * @param {string} projectId Project id.
 * @returns {readonly unknown[]}
 */
export function projectDetailQueryKey(projectId) {
  return Object.freeze(['projects', 'detail', String(projectId)]);
}

/** Prefix for invalidating every project detail query. */
export const PROJECTS_DETAIL_QUERY_ROOT = Object.freeze(['projects', 'detail']);

/**
 * Builds the deletion-preview query key.
 * @param {string} projectId Project id.
 * @returns {readonly unknown[]}
 */
export function projectDeletionPreviewQueryKey(projectId) {
  return Object.freeze(['projects', 'deletionPreview', String(projectId)]);
}

/**
 * Lists accessible projects with keyset pagination.
 * @param {{
 *   q?: string,
 *   includeArchived?: boolean,
 *   sort?: 'updatedAt' | 'lastAccessedAt',
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} [options] List options.
 * @returns {Promise<ProjectListPage>}
 */
export async function listProjects(options = {}) {
  const { signal, ...filters } = options;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({
    q: filters.q,
    includeArchived: filters.includeArchived === true ? 'true' : undefined,
    sort: filters.sort,
    cursor: filters.cursor,
    limit: filters.limit ?? PROJECTS_LIST_DEFAULT_LIMIT,
  })) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return apiRequest(`/masters/projects/list${encoded ? `?${encoded}` : ''}`, { signal });
}

/**
 * Fetches one project by id.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<ProjectDto>}
 */
export async function getProject(projectId, options = {}) {
  return apiRequest(`/masters/projects/get/${encodeURIComponent(projectId)}`, {
    signal: options.signal,
  });
}

/**
 * Creates a project (requires Idempotency-Key).
 * @param {{
 *   name: string,
 *   description?: string,
 *   sourceType: 'upload' | 'repository',
 *   idempotencyKey: string,
 * }} input Create payload.
 * @returns {Promise<ProjectDto>}
 */
export async function createProject(input) {
  return apiRequest('/masters/projects/create', {
    method: 'POST',
    body: {
      name: input.name,
      description: input.description,
      sourceType: input.sourceType,
    },
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Patches project name and/or description.
 * @param {string} projectId Project id.
 * @param {{ name?: string, description?: string }} patch Fields to update.
 * @returns {Promise<ProjectDto>}
 */
export async function patchProject(projectId, patch) {
  return apiRequest('/masters/projects/update', {
    method: 'PATCH',
    body: { projectId, ...patch },
  });
}

/**
 * Asks the API to write project.description from the root README via the LLM.
 * @param {string} projectId Project id.
 * @returns {Promise<ProjectDto>}
 */
export async function fillProjectDescriptionFromReadme(projectId) {
  return apiRequest('/masters/projects/fillDescriptionFromReadme', {
    method: 'POST',
    body: { projectId },
  });
}

/**
 * Archives a project.
 * @param {string} projectId Project id.
 * @returns {Promise<ProjectDto>}
 */
export async function archiveProject(projectId) {
  return apiRequest('/masters/projects/archive', {
    method: 'POST',
    body: { projectId },
  });
}

/**
 * Restores an archived project.
 * @param {string} projectId Project id.
 * @returns {Promise<ProjectDto>}
 */
export async function restoreProject(projectId) {
  return apiRequest('/masters/projects/restore', {
    method: 'POST',
    body: { projectId },
  });
}

/**
 * Soft-deletes a project.
 * @param {string} projectId Project id.
 * @returns {Promise<void>}
 */
export async function deleteProject(projectId) {
  return apiRequest('/masters/projects/delete', {
    method: 'DELETE',
    body: { projectId },
  });
}

/**
 * Fetches deletion consequences and counts for a project.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<ProjectDeletionPreview>}
 */
export async function getProjectDeletionPreview(projectId, options = {}) {
  return apiRequest(`/masters/projects/getDeletionPreview/${encodeURIComponent(projectId)}`, {
    signal: options.signal,
  });
}

/**
 * Records that a project was opened (bumps org-scoped lastAccessedAt).
 * @param {string} projectId Project id.
 * @returns {Promise<ProjectDto>}
 */
export async function recordProjectAccess(projectId) {
  return apiRequest('/masters/projects/recordAccess', {
    method: 'POST',
    body: { projectId },
  });
}
