/**
 * Debounced project conversation search against the backend.
 */
import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { conversationsSearchQueryKey } from '@/features/chat/conversationQueryKeys.js';
import { searchConversations, CONVERSATION_SEARCH_DEBOUNCE_MS, CONVERSATIONS_SEARCH_DEFAULT_LIMIT } from '@/features/chat/api/conversationsApi.js';

/**
 * Debounced search of the caller's conversations in a project.
 * @param {string} projectId Project id.
 * @param {{
 *   q?: string,
 *   archived?: boolean,
 *   limit?: number,
 *   enabled?: boolean,
 *   debounceMs?: number,
 * }} [filters] Search filters.
 * @returns {{
 *   debouncedQuery: string,
 *   query: import('@tanstack/react-query').UseInfiniteQueryResult,
 *   hits: object[],
 * }}
 */
export function useConversationSearch(projectId, filters = {}) {
  const id = projectId ? String(projectId) : '';
  const rawQuery = typeof filters.q === 'string' ? filters.q.trim() : '';
  const debounceMs = filters.debounceMs ?? CONVERSATION_SEARCH_DEBOUNCE_MS;
  const [debouncedQuery, setDebouncedQuery] = useState(rawQuery);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(rawQuery);
    }, debounceMs);
    return () => window.clearTimeout(handle);
  }, [rawQuery, debounceMs]);

  const archived = Boolean(filters.archived);
  const limit = filters.limit;
  const enabled = Boolean(id) && Boolean(debouncedQuery) && filters.enabled !== false;

  const query = useInfiniteQuery({
    queryKey: conversationsSearchQueryKey(id || 'missing', {
      q: debouncedQuery,
      archived,
      limit,
    }),
    queryFn: ({ pageParam, signal }) =>
      searchConversations(id, {
        q: debouncedQuery,
        archived,
        cursor: pageParam,
        limit: limit ?? CONVERSATIONS_SEARCH_DEFAULT_LIMIT,
        signal,
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => {
      const nextCursor = lastPage?.nextCursor;
      if (typeof nextCursor === 'string' && nextCursor) {
        return nextCursor;
      }
      return undefined;
    },
    enabled,
  });

  const hits = flattenSearchPages(query.data);

  return { debouncedQuery, query, hits };
}

/**
 * Flattens infinite-query search pages into one array.
 * @param {{ pages?: Array<{ items?: object[] }> } | undefined} data Infinite query data.
 * @returns {object[]}
 */
export function flattenSearchPages(data) {
  if (!data?.pages) {
    return [];
  }
  return data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
}
