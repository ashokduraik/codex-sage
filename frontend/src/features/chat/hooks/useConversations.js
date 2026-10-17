/**
 * Infinite keyset list of the caller's project conversations.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { conversationsListQueryKey } from '@/features/chat/conversationQueryKeys.js';
import { listConversations, CONVERSATIONS_LIST_DEFAULT_LIMIT } from '@/features/chat/api/conversationsApi.js';

/**
 * Infinite conversations list for a project (recent or archived).
 * @param {string} projectId Project id.
 * @param {{
 *   archived?: boolean,
 *   limit?: number,
 *   enabled?: boolean,
 * }} [filters] List filters.
 * @returns Infinite query result for conversations.
 */
export function useConversations(projectId, filters = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && filters.enabled !== false;
  const archived = Boolean(filters.archived);
  const limit = filters.limit;

  return useInfiniteQuery({
    queryKey: conversationsListQueryKey(id || 'missing', { archived, limit }),
    queryFn: ({ pageParam, signal }) =>
      listConversations(id, {
        archived,
        cursor: pageParam,
        limit: limit ?? CONVERSATIONS_LIST_DEFAULT_LIMIT,
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
}

/**
 * Flattens infinite-query conversation pages into one array.
 * @param {{ pages?: Array<{ items?: object[] }> } | undefined} data Infinite query data.
 * @returns {object[]}
 */
export function flattenConversationPages(data) {
  if (!data?.pages) {
    return [];
  }
  return data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
}
