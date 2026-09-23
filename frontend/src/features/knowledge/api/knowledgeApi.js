/**
 * Knowledge browse and health HTTP calls (Phase 37).
 */
import { apiRequest } from '@/shared/api';

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
