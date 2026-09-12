/**
 * Projects HTTP calls over the shared API client (Phase 19).
 */
import { apiRequest } from '@/shared/api';

/** Default page size for project lists. */
export const PROJECTS_LIST_DEFAULT_LIMIT = 20;

/**
 * Builds a query string from defined filter values.
 * @param {Record<string, string | number | boolean | undefined | null>} params Query map.
 * @returns {string} Path suffix starting with `?`, or empty string.
 */
function toQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
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
 * @returns {Promise<import('./projectTypes.js').ProjectListPage>}
 */
export async function listProjects(options = {}) {
  const { signal, ...filters } = options;
  const query = toQueryString({
    q: filters.q,
    includeArchived: filters.includeArchived === true ? 'true' : undefined,
    sort: filters.sort,
    cursor: filters.cursor,
    limit: filters.limit ?? PROJECTS_LIST_DEFAULT_LIMIT,
  });
  return apiRequest(`/projects${query}`, { signal });
}

/**
 * Fetches one project by id.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<import('./projectTypes.js').ProjectDto>}
 */
export async function getProject(projectId, options = {}) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}`, {
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
 * @returns {Promise<import('./projectTypes.js').ProjectDto>}
 */
export async function createProject(input) {
  return apiRequest('/projects', {
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
 * @returns {Promise<import('./projectTypes.js').ProjectDto>}
 */
export async function patchProject(projectId, patch) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/**
 * Archives a project.
 * @param {string} projectId Project id.
 * @returns {Promise<import('./projectTypes.js').ProjectDto>}
 */
export async function archiveProject(projectId) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/archive`, {
    method: 'POST',
  });
}

/**
 * Restores an archived project.
 * @param {string} projectId Project id.
 * @returns {Promise<import('./projectTypes.js').ProjectDto>}
 */
export async function restoreProject(projectId) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/restore`, {
    method: 'POST',
  });
}

/**
 * Soft-deletes a project.
 * @param {string} projectId Project id.
 * @returns {Promise<void>}
 */
export async function deleteProject(projectId) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
}

/**
 * Fetches deletion consequences and counts for a project.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<import('./projectTypes.js').ProjectDeletionPreview>}
 */
export async function getProjectDeletionPreview(projectId, options = {}) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/deletion-preview`, {
    signal: options.signal,
  });
}

/**
 * Records that a project was opened (bumps org-scoped lastAccessedAt).
 * @param {string} projectId Project id.
 * @returns {Promise<import('./projectTypes.js').ProjectDto>}
 */
export async function recordProjectAccess(projectId) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/access`, {
    method: 'POST',
  });
}
