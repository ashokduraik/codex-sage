/**
 * Conversation header detail query.
 */
import { useQuery } from '@tanstack/react-query';
import { getConversation } from '@/features/chat/api/conversationsApi.js';
import { conversationDetailQueryKey } from '@/features/chat/conversationQueryKeys.js';

/**
 * Loads one conversation header for the project chat shell.
 * @param {string} projectId Project id.
 * @param {string | null | undefined} conversationId Conversation id when selected.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useConversation(projectId, conversationId, options = {}) {
  const project = projectId ? String(projectId) : '';
  const conversation = conversationId ? String(conversationId) : '';
  const enabled = Boolean(project) && Boolean(conversation) && options.enabled !== false;

  return useQuery({
    queryKey: conversationDetailQueryKey(project || 'missing', conversation || 'missing'),
    queryFn: ({ signal }) => getConversation(project, conversation, { signal }),
    enabled,
  });
}
