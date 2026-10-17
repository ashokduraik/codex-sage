/**
 * Knowledge browse, search, preview, health, and change-summary HTTP calls.
 * Source preview HTTP helpers live in shared/source-preview and are re-exported here
 * so existing knowledge callers keep a stable import path.
 */
import { ApiError, apiRequest } from '@/shared/api';
import { fetchSourceFileMetadata, fetchSourceSlice, sourcePreviewQueryKey } from '@/shared/source-preview/sourcePreviewApi.js';

export { fetchSourceFileMetadata, fetchSourceSlice, sourcePreviewQueryKey };

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
 * Loads knowledge facets for a project.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object>}
 */
export async function fetchKnowledgeFacets(projectId, options = {}) {
  return apiRequest(`/knowledge/knowledge/getIndex/${encodeURIComponent(projectId)}`, {
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
  return apiRequest(`/knowledge/knowledge/getSummary/${encodeURIComponent(projectId)}`, {
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
  return apiRequest(`/knowledge/knowledge/listWorkflows/${encodeURIComponent(projectId)}`, {
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
  return apiRequest(`/knowledge/knowledge/listApis/${encodeURIComponent(projectId)}`, {
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
  const search = new URLSearchParams();
  if (q !== undefined && q !== null && q !== '') {
    search.set('q', String(q));
  }
  const encoded = search.toString();
  return apiRequest(`/knowledge/knowledge/listSymbols/${encodeURIComponent(projectId)}${encoded ? `?${encoded}` : ''}`, {
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
  return apiRequest(`/knowledge/knowledge/getHealth/${encodeURIComponent(projectId)}`, {
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
    return await apiRequest(`/knowledge/changeSummary/getLatest/${encodeURIComponent(projectId)}`, { signal: options.signal });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.code === 'CHANGE_SUMMARY_NOT_FOUND')) {
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
  return apiRequest(`/knowledge/search/run/${encodeURIComponent(options.projectId)}?${search.toString()}`, { signal: options.signal });
}
