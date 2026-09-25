/**
 * Knowledge browse, search, preview, health, and change-summary HTTP calls.
 */
import { ApiError, apiRequest } from '@/shared/api';

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

/** Debounce for the search input. */
export const KNOWLEDGE_SEARCH_DEBOUNCE_MS = 300;

/**
 * Builds a query string from defined values.
 * @param {Record<string, string | number | undefined | null>} params Query map.
 * @returns {string}
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
 * Loads knowledge facets for a project.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object>}
 */
export async function fetchKnowledgeFacets(projectId, options = {}) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/knowledge`, {
    signal: options.signal,
  });
}

/**
 * Loads the extractive knowledge summary.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object>}
 */
export async function fetchKnowledgeSummary(projectId, options = {}) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/knowledge/summary`, {
    signal: options.signal,
  });
}

/**
 * Loads workflow browse items.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object>}
 */
export async function fetchKnowledgeWorkflows(projectId, options = {}) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/knowledge/workflows`, {
    signal: options.signal,
  });
}

/**
 * Loads API browse items.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object>}
 */
export async function fetchKnowledgeApis(projectId, options = {}) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/knowledge/apis`, {
    signal: options.signal,
  });
}

/**
 * Loads symbol browse items. Requires `q` (min length 2).
 * @param {string} projectId Project id.
 * @param {string} q Symbol prefix.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object>}
 */
export async function fetchKnowledgeSymbols(projectId, q, options = {}) {
  const query = toQueryString({ q });
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/knowledge/symbols${query}`, {
    signal: options.signal,
  });
}

/**
 * Loads knowledge health dimensions.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object>}
 */
export async function fetchKnowledgeHealth(projectId, options = {}) {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/knowledge/health`, {
    signal: options.signal,
  });
}

/**
 * Loads the latest computed change summary. 404 becomes null.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object | null>}
 */
export async function fetchChangeSummary(projectId, options = {}) {
  try {
    return await apiRequest(
      `/projects/${encodeURIComponent(projectId)}/knowledge/updates/latest`,
      { signal: options.signal },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.code === 'CHANGE_SUMMARY_NOT_FOUND')
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Runs project-scoped knowledge search.
 * @param {{
 *   projectId: string,
 *   q: string,
 *   types?: string,
 *   signal?: AbortSignal,
 * }} options Search options.
 * @returns {Promise<object>}
 */
export async function fetchProjectSearch(options) {
  const search = new URLSearchParams();
  search.set('q', options.q);
  if (options.types) {
    search.set('types', options.types);
  }
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/search?${search.toString()}`,
    { signal: options.signal },
  );
}

/**
 * Loads file metadata for a project-relative path.
 * @param {{ projectId: string, path: string, signal?: AbortSignal }} options Request.
 * @returns {Promise<object>}
 */
export async function fetchSourceFileMetadata(options) {
  const search = new URLSearchParams({ path: options.path });
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/files?${search.toString()}`,
    { signal: options.signal },
  );
}

/**
 * Loads a bounded line slice.
 * @param {{
 *   projectId: string,
 *   path: string,
 *   startLine: number,
 *   endLine: number,
 *   signal?: AbortSignal,
 * }} options Request.
 * @returns {Promise<object>}
 */
export async function fetchSourceSlice(options) {
  const search = new URLSearchParams({
    path: options.path,
    startLine: String(options.startLine),
    endLine: String(options.endLine),
  });
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/files/slice?${search.toString()}`,
    { signal: options.signal },
  );
}
