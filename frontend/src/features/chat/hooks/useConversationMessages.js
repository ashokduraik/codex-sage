/**
 * Infinite message pages for a conversation (oldest → newest), auto-fetched to the end.
 */
import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { conversationMessagesQueryKey } from '@/features/chat/conversationQueryKeys.js';
import { listConversationMessages, MESSAGES_LIST_DEFAULT_LIMIT, MESSAGES_AUTO_FETCH_MAX_PAGES } from '@/features/chat/api/conversationsApi.js';

/**
 * Loads messages for a conversation and keeps fetching newer pages until exhausted.
 * @param {string} projectId Project id.
 * @param {string | null | undefined} conversationId Conversation id when selected.
 * @param {{
 *   limit?: number,
 *   enabled?: boolean,
 *   maxAutoFetchPages?: number,
 * }} [options] Query options.
 * @returns Infinite query result plus flattened messages.
 */
export function useConversationMessages(projectId, conversationId, options = {}) {
  const project = projectId ? String(projectId) : '';
  const conversation = conversationId ? String(conversationId) : '';
  const enabled = Boolean(project) && Boolean(conversation) && options.enabled !== false;
  const limit = options.limit;
  const maxPages = options.maxAutoFetchPages ?? MESSAGES_AUTO_FETCH_MAX_PAGES;

  const query = useInfiniteQuery({
    queryKey: conversationMessagesQueryKey(project || 'missing', conversation || 'missing', { limit }),
    queryFn: ({ pageParam, signal }) =>
      listConversationMessages(project, conversation, {
        cursor: pageParam,
        limit: limit ?? MESSAGES_LIST_DEFAULT_LIMIT,
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

  const { hasNextPage, isFetchingNextPage, fetchNextPage, data } = query;
  const pageCount = data?.pages?.length ?? 0;

  useEffect(() => {
    if (!enabled || !hasNextPage || isFetchingNextPage) {
      return;
    }
    if (pageCount >= maxPages) {
      return;
    }
    void fetchNextPage();
  }, [enabled, maxPages, pageCount, fetchNextPage, hasNextPage, isFetchingNextPage]);

  return query;
}

/**
 * Flattens infinite-query message pages into one array (oldest → newest).
 * @param {{ pages?: Array<{ items?: object[] }> } | undefined} data Infinite query data.
 * @returns {object[]}
 */
export function flattenMessagePages(data) {
  if (!data?.pages) {
    return [];
  }
  return data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
}
