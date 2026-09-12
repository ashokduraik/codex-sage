/**
 * React Query keys for the projects feature.
 */

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
