/**
 * React Query key factories for project-scoped conversations.
 */

/** Prefix for invalidating every conversation list under a project (or all). */
export const CONVERSATIONS_LIST_QUERY_ROOT = Object.freeze(['conversations', 'list']);

/** Prefix for invalidating conversation detail queries. */
export const CONVERSATIONS_DETAIL_QUERY_ROOT = Object.freeze(['conversations', 'detail']);

/** Prefix for invalidating message list queries. */
export const CONVERSATIONS_MESSAGES_QUERY_ROOT = Object.freeze(['conversations', 'messages']);

/** Prefix for invalidating search queries. */
export const CONVERSATIONS_SEARCH_QUERY_ROOT = Object.freeze(['conversations', 'search']);

/**
 * Builds the infinite conversation-list query key (cursor is not part of the key).
 * @param {string} projectId Project id.
 * @param {{ archived?: boolean, limit?: number }} [filters] List filters.
 * @returns {readonly unknown[]}
 */
export function conversationsListQueryKey(projectId, filters = {}) {
  return Object.freeze([
    'conversations',
    'list',
    String(projectId),
    {
      archived: Boolean(filters.archived),
      limit: filters.limit ?? null,
    },
  ]);
}

/**
 * Builds the conversation detail query key.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @returns {readonly unknown[]}
 */
export function conversationDetailQueryKey(projectId, conversationId) {
  return Object.freeze(['conversations', 'detail', String(projectId), String(conversationId)]);
}

/**
 * Builds the infinite messages query key.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {{ limit?: number }} [filters] Page size filters.
 * @returns {readonly unknown[]}
 */
export function conversationMessagesQueryKey(projectId, conversationId, filters = {}) {
  return Object.freeze(['conversations', 'messages', String(projectId), String(conversationId), { limit: filters.limit ?? null }]);
}

/**
 * Builds the infinite search query key (cursor is not part of the key).
 * @param {string} projectId Project id.
 * @param {{ q?: string, archived?: boolean, limit?: number }} [filters] Search filters.
 * @returns {readonly unknown[]}
 */
export function conversationsSearchQueryKey(projectId, filters = {}) {
  return Object.freeze([
    'conversations',
    'search',
    String(projectId),
    {
      q: filters.q ?? '',
      archived: Boolean(filters.archived),
      limit: filters.limit ?? null,
    },
  ]);
}
