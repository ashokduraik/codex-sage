/**
 * React Query keys for knowledge browse, search, preview, and changes.
 */

/**
 * Builds the knowledge facets query key.
 * @param {string} projectId Project id.
 * @returns {readonly unknown[]}
 */
export function knowledgeFacetsQueryKey(projectId) {
  return Object.freeze(['projects', String(projectId), 'knowledge', 'facets']);
}

/**
 * Builds a knowledge facet-detail query key.
 * @param {string} projectId Project id.
 * @param {string} kind Facet kind.
 * @param {string} [q] Optional symbol query.
 * @returns {readonly unknown[]}
 */
export function knowledgeFacetQueryKey(projectId, kind, q = '') {
  return Object.freeze(['projects', String(projectId), 'knowledge', kind, q]);
}

/**
 * Builds the knowledge health query key.
 * @param {string} projectId Project id.
 * @returns {readonly unknown[]}
 */
export function knowledgeHealthQueryKey(projectId) {
  return Object.freeze(['projects', String(projectId), 'knowledge', 'health']);
}

/**
 * Builds the project search query key.
 * @param {string} projectId Project id.
 * @param {string} q Query.
 * @param {string} types Types token list.
 * @returns {readonly unknown[]}
 */
export function projectSearchQueryKey(projectId, q, types) {
  return Object.freeze(['projects', String(projectId), 'search', q, types]);
}

/**
 * Builds the source preview query key.
 * @param {string} projectId Project id.
 * @param {string} path File path.
 * @param {{ startLine?: number, endLine?: number }} [range] Optional slice.
 * @returns {readonly unknown[]}
 */
export function sourcePreviewQueryKey(projectId, path, range = {}) {
  return Object.freeze([
    'projects',
    String(projectId),
    'files',
    path,
    range.startLine ?? null,
    range.endLine ?? null,
  ]);
}

/**
 * Builds the change-summary query key.
 * @param {string} projectId Project id.
 * @returns {readonly unknown[]}
 */
export function changeSummaryQueryKey(projectId) {
  return Object.freeze(['projects', String(projectId), 'knowledge', 'updates', 'latest']);
}
