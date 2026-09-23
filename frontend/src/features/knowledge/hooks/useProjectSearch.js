/**
 * Debounced project search query.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchProjectSearch, KNOWLEDGE_SEARCH_DEBOUNCE_MS } from '../api/searchApi.js';
import { projectSearchQueryKey } from '../api/knowledgeKeys.js';

/**
 * Searches project knowledge after the query is long enough and debounced.
 * @param {string | undefined | null} projectId Project id.
 * @param {string} q Raw input.
 * @param {string} types Comma-separated type tokens, or empty for all.
 * @returns {import('@tanstack/react-query').UseQueryResult & { debouncedQ: string }}
 */
export function useProjectSearch(projectId, q, types) {
  const id = projectId ? String(projectId) : '';
  const trimmed = typeof q === 'string' ? q.trim() : '';
  const [debouncedQ, setDebouncedQ] = useState(trimmed);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQ(trimmed);
    }, KNOWLEDGE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [trimmed]);

  const enabled = Boolean(id) && debouncedQ.length >= 2;
  const query = useQuery({
    queryKey: projectSearchQueryKey(id || 'missing', debouncedQ, types || 'all'),
    queryFn: ({ signal }) =>
      fetchProjectSearch({
        projectId: id,
        q: debouncedQ,
        types: types || undefined,
        signal,
      }),
    enabled,
  });
  return { ...query, debouncedQ };
}
