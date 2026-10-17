/**
 * Conversation create / rename / archive / restore / delete mutations.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createConversation,
  deleteConversation,
  renameConversation,
  archiveConversation,
  restoreConversation,
} from '@/features/chat/api/conversationsApi.js';
import {
  conversationsListQueryKey,
  conversationDetailQueryKey,
  CONVERSATIONS_LIST_QUERY_ROOT,
  CONVERSATIONS_DETAIL_QUERY_ROOT,
  CONVERSATIONS_SEARCH_QUERY_ROOT,
  CONVERSATIONS_MESSAGES_QUERY_ROOT,
} from '@/features/chat/conversationQueryKeys.js';

/**
 * Create-conversation mutation (caller supplies Idempotency-Key).
 * @param {string} projectId Project id.
 * @returns Create mutation.
 */
export function useCreateConversation(projectId) {
  const queryClient = useQueryClient();
  const project = String(projectId ?? '');
  return useMutation({
    /**
     * @param {{ title?: string, idempotencyKey: string }} input Create payload.
     */
    mutationFn: (input) => createConversation(project, input),
    onSuccess: () => {
      invalidateConversationLists(queryClient, project);
      invalidateConversationSearch(queryClient, project);
    },
  });
}

/**
 * Rename mutation with optimistic title update and rollback.
 * @param {string} projectId Project id.
 * @returns Rename mutation.
 */
export function useRenameConversation(projectId) {
  const queryClient = useQueryClient();
  const project = String(projectId ?? '');
  return useMutation({
    /**
     * @param {{ conversationId: string, title: string, previousTitle?: string }} input Rename payload.
     */
    mutationFn: (input) =>
      renameConversation(project, input.conversationId, {
        title: input.title,
      }),
    onMutate: async (input) => {
      const detailKey = conversationDetailQueryKey(project, input.conversationId);
      await queryClient.cancelQueries({ queryKey: detailKey });
      await queryClient.cancelQueries({ queryKey: CONVERSATIONS_LIST_QUERY_ROOT });
      const previousDetail = queryClient.getQueryData(detailKey);
      const previousLists = queryClient.getQueriesData({ queryKey: CONVERSATIONS_LIST_QUERY_ROOT });
      if (previousDetail) {
        queryClient.setQueryData(detailKey, { ...previousDetail, title: input.title });
      }
      for (const [key, data] of previousLists) {
        if (!data?.pages) {
          continue;
        }
        queryClient.setQueryData(key, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: (Array.isArray(page.items) ? page.items : []).map((row) =>
              String(row.id) === String(input.conversationId) ? { ...row, title: input.title } : row,
            ),
          })),
        });
      }
      return { previousDetail, previousLists, conversationId: input.conversationId };
    },
    onError: (_error, input, context) => {
      if (context?.previousDetail) {
        queryClient.setQueryData(conversationDetailQueryKey(project, input.conversationId), context.previousDetail);
      }
      for (const [key, data] of context?.previousLists ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: (_data, _error, input) => {
      invalidateConversationLists(queryClient, project);
      invalidateConversationSearch(queryClient, project);
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(project, input.conversationId),
      });
    },
  });
}

/**
 * Archive mutation with optimistic removal from the recent list.
 * @param {string} projectId Project id.
 * @returns Archive mutation.
 */
export function useArchiveConversation(projectId) {
  const queryClient = useQueryClient();
  const project = String(projectId ?? '');
  return useMutation({
    /** @param {string} conversationId Conversation id. */
    mutationFn: (conversationId) => archiveConversation(project, conversationId),
    onMutate: async (conversationId) => {
      await queryClient.cancelQueries({ queryKey: CONVERSATIONS_LIST_QUERY_ROOT });
      const previous = snapshotListCaches(queryClient);
      optimisticallyMoveLifecycle(queryClient, project, conversationId, 'archived');
      return { previous, conversationId };
    },
    onError: (_error, _conversationId, context) => {
      restoreListCaches(queryClient, context?.previous ?? []);
    },
    onSettled: (_data, _error, conversationId) => {
      invalidateConversationLists(queryClient, project);
      invalidateConversationSearch(queryClient, project);
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(project, conversationId),
      });
    },
  });
}

/**
 * Restore mutation.
 * @param {string} projectId Project id.
 * @returns Restore mutation.
 */
export function useRestoreConversation(projectId) {
  const queryClient = useQueryClient();
  const project = String(projectId ?? '');
  return useMutation({
    /** @param {string} conversationId Conversation id. */
    mutationFn: (conversationId) => restoreConversation(project, conversationId),
    onMutate: async (conversationId) => {
      await queryClient.cancelQueries({ queryKey: CONVERSATIONS_LIST_QUERY_ROOT });
      const previous = snapshotListCaches(queryClient);
      optimisticallyMoveLifecycle(queryClient, project, conversationId, 'active');
      return { previous, conversationId };
    },
    onError: (_error, _conversationId, context) => {
      restoreListCaches(queryClient, context?.previous ?? []);
    },
    onSettled: (_data, _error, conversationId) => {
      invalidateConversationLists(queryClient, project);
      invalidateConversationSearch(queryClient, project);
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(project, conversationId),
      });
    },
  });
}

/**
 * Soft-delete mutation.
 * @param {string} projectId Project id.
 * @returns Delete mutation.
 */
export function useDeleteConversation(projectId) {
  const queryClient = useQueryClient();
  const project = String(projectId ?? '');
  return useMutation({
    /** @param {string} conversationId Conversation id. */
    mutationFn: (conversationId) => deleteConversation(project, conversationId),
    onSuccess: (_data, conversationId) => {
      invalidateConversationLists(queryClient, project);
      invalidateConversationSearch(queryClient, project);
      queryClient.removeQueries({
        queryKey: conversationDetailQueryKey(project, conversationId),
      });
      queryClient.removeQueries({
        queryKey: ['conversations', 'messages', project, String(conversationId)],
      });
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_DETAIL_QUERY_ROOT });
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_MESSAGES_QUERY_ROOT });
    },
  });
}

/**
 * Invalidates list queries for one project (or all when project empty).
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {string} projectId Project id.
 */
function invalidateConversationLists(queryClient, projectId) {
  if (projectId) {
    return queryClient.invalidateQueries({
      queryKey: ['conversations', 'list', projectId],
    });
  }
  return queryClient.invalidateQueries({ queryKey: CONVERSATIONS_LIST_QUERY_ROOT });
}

/**
 * Invalidates search queries for one project.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {string} projectId Project id.
 */
function invalidateConversationSearch(queryClient, projectId) {
  if (projectId) {
    return queryClient.invalidateQueries({
      queryKey: ['conversations', 'search', projectId],
    });
  }
  return queryClient.invalidateQueries({ queryKey: CONVERSATIONS_SEARCH_QUERY_ROOT });
}

/**
 * Snapshots all conversation list caches for rollback.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @returns {Array<[unknown, unknown]>}
 */
function snapshotListCaches(queryClient) {
  return queryClient.getQueriesData({ queryKey: CONVERSATIONS_LIST_QUERY_ROOT });
}

/**
 * Restores list caches after a failed optimistic update.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {Array<[unknown, unknown]>} previous Snapshot.
 */
function restoreListCaches(queryClient, previous) {
  for (const [key, data] of previous) {
    queryClient.setQueryData(key, data);
  }
}

/**
 * Moves a conversation between recent/archived infinite caches for one project.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {'active' | 'archived'} lifecycleStatus Target lifecycle.
 */
function optimisticallyMoveLifecycle(queryClient, projectId, conversationId, lifecycleStatus) {
  const recentKey = conversationsListQueryKey(projectId, { archived: false });
  const archivedKey = conversationsListQueryKey(projectId, { archived: true });
  const fromArchived = lifecycleStatus === 'active';
  const sourceKey = fromArchived ? archivedKey : recentKey;
  const targetKey = fromArchived ? recentKey : archivedKey;
  const sourceData = queryClient.getQueryData(sourceKey);
  let moved = null;
  if (sourceData?.pages) {
    queryClient.setQueryData(sourceKey, {
      ...sourceData,
      pages: sourceData.pages.map((page) => {
        const items = Array.isArray(page.items) ? page.items : [];
        const nextItems = [];
        for (const row of items) {
          if (String(row.id) === String(conversationId)) {
            moved = { ...row, lifecycleStatus };
          } else {
            nextItems.push(row);
          }
        }
        return { ...page, items: nextItems };
      }),
    });
  }
  if (!moved) {
    return;
  }
  const targetData = queryClient.getQueryData(targetKey);
  if (!targetData?.pages?.length) {
    queryClient.setQueryData(targetKey, {
      pages: [{ items: [moved], nextCursor: null }],
      pageParams: [undefined],
    });
    return;
  }
  queryClient.setQueryData(targetKey, {
    ...targetData,
    pages: targetData.pages.map((page, index) =>
      index === 0
        ? {
            ...page,
            items: [moved, ...(Array.isArray(page.items) ? page.items : [])],
          }
        : page,
    ),
  });
}
