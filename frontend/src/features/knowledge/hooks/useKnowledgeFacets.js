/**
 * Knowledge facets and health queries.
 */
import { useQuery } from '@tanstack/react-query';
import {
  fetchKnowledgeApis,
  fetchKnowledgeFacets,
  fetchKnowledgeHealth,
  fetchKnowledgeSummary,
  fetchKnowledgeSymbols,
  fetchKnowledgeWorkflows,
} from '../api/knowledgeApi.js';
import {
  knowledgeFacetQueryKey,
  knowledgeFacetsQueryKey,
  knowledgeHealthQueryKey,
} from '../api/knowledgeKeys.js';

/**
 * Loads GET /knowledge facets.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useKnowledgeFacets(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;
  return useQuery({
    queryKey: knowledgeFacetsQueryKey(id || 'missing'),
    queryFn: ({ signal }) => fetchKnowledgeFacets(id, { signal }),
    enabled,
  });
}

/**
 * Loads GET /knowledge/health.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useKnowledgeHealth(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;
  return useQuery({
    queryKey: knowledgeHealthQueryKey(id || 'missing'),
    queryFn: ({ signal }) => fetchKnowledgeHealth(id, { signal }),
    enabled,
  });
}

/**
 * Loads a facet child list or summary when expanded.
 * @param {string | undefined | null} projectId Project id.
 * @param {string | null} kind Facet key.
 * @param {{ q?: string, enabled?: boolean }} [options] Query options.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useKnowledgeFacet(projectId, kind, options = {}) {
  const id = projectId ? String(projectId) : '';
  const q = options.q ?? '';
  const enabled = Boolean(id) && Boolean(kind) && options.enabled !== false;
  return useQuery({
    queryKey: knowledgeFacetQueryKey(id || 'missing', kind || 'none', q),
    queryFn: ({ signal }) => {
      if (kind === 'summary' || kind === 'documentation') {
        return fetchKnowledgeSummary(id, { signal });
      }
      if (kind === 'workflows') {
        return fetchKnowledgeWorkflows(id, { signal });
      }
      if (kind === 'apis') {
        return fetchKnowledgeApis(id, { signal });
      }
      return fetchKnowledgeSymbols(id, q, { signal });
    },
    enabled,
  });
}
