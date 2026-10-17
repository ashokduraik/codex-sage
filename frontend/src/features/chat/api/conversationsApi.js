/**
 * Conversation HTTP calls for the project chat shell (Phase 54).
 * Paths match `backend/src/http/route.js` under API_BASE_PATH.
 */
import { apiRequest } from '@/shared/api';

/** Default page size for conversation lists (matches BE default). */
export const CONVERSATIONS_LIST_DEFAULT_LIMIT = 20;

/** Default page size for message lists (matches BE default). */
export const MESSAGES_LIST_DEFAULT_LIMIT = 50;

/** Default page size for conversation search (matches BE default). */
export const CONVERSATIONS_SEARCH_DEFAULT_LIMIT = 20;

/** Debounce for sidebar search input (ms). */
export const CONVERSATION_SEARCH_DEBOUNCE_MS = 300;

/** Max message pages to auto-fetch when opening a thread (50 × 20 = 1000 turns). */
export const MESSAGES_AUTO_FETCH_MAX_PAGES = 20;

/**
 * Appends defined query params to a path.
 * @param {string} path Base path.
 * @param {Record<string, string | number | boolean | undefined | null>} params Query map.
 * @returns {string}
 */
function withQuery(path, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `${path}?${encoded}` : path;
}

/**
 * Lists the caller's conversations in a project (keyset).
 * @param {string} projectId Project id.
 * @param {{
 *   archived?: boolean,
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} [options] List options.
 * @returns {Promise<import('./conversationTypes.js').ConversationListPage>}
 */
export async function listConversations(projectId, options = {}) {
  const { signal, archived, cursor, limit } = options;
  const path = withQuery(`/conversation/conversation/list/${encodeURIComponent(projectId)}`, {
    archived: archived === true ? 'true' : undefined,
    cursor,
    limit: limit ?? CONVERSATIONS_LIST_DEFAULT_LIMIT,
  });
  return apiRequest(path, { signal });
}

/**
 * Searches the caller's conversations in a project.
 * @param {string} projectId Project id.
 * @param {{
 *   q?: string,
 *   archived?: boolean,
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} [options] Search options.
 * @returns {Promise<import('./conversationTypes.js').ConversationSearchPage>}
 */
export async function searchConversations(projectId, options = {}) {
  const { signal, q, archived, cursor, limit } = options;
  const path = withQuery(`/conversation/conversation/search/${encodeURIComponent(projectId)}`, {
    q,
    archived: archived === true ? 'true' : undefined,
    cursor,
    limit: limit ?? CONVERSATIONS_SEARCH_DEFAULT_LIMIT,
  });
  return apiRequest(path, { signal });
}

/**
 * Loads one conversation header.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<import('./conversationTypes.js').ConversationDto>}
 */
export async function getConversation(projectId, conversationId, options = {}) {
  return apiRequest(`/conversation/conversation/get/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}`, {
    signal: options.signal,
  });
}

/**
 * Lists messages for a conversation (oldest → newest keyset).
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {{ cursor?: string, limit?: number, signal?: AbortSignal }} [options] Page options.
 * @returns {Promise<import('./conversationTypes.js').MessageListPage>}
 */
export async function listConversationMessages(projectId, conversationId, options = {}) {
  const { signal, cursor, limit } = options;
  const path = withQuery(`/conversation/conversation/listMessages/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}`, {
    cursor,
    limit: limit ?? MESSAGES_LIST_DEFAULT_LIMIT,
  });
  return apiRequest(path, { signal });
}

/**
 * Creates a conversation (Idempotency-Key required).
 * @param {string} projectId Project id.
 * @param {{ title?: string, idempotencyKey: string }} input Create payload.
 * @returns {Promise<import('./conversationTypes.js').ConversationDto>}
 */
export async function createConversation(projectId, input) {
  return apiRequest(`/conversation/conversation/create/${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: input.title ? { title: input.title } : {},
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Renames a conversation title.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {{ title: string }} input Rename payload.
 * @returns {Promise<import('./conversationTypes.js').ConversationDto>}
 */
export async function renameConversation(projectId, conversationId, input) {
  return apiRequest(`/conversation/conversation/rename/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: { title: input.title },
  });
}

/**
 * Archives an active conversation.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @returns {Promise<import('./conversationTypes.js').ConversationDto>}
 */
export async function archiveConversation(projectId, conversationId) {
  return apiRequest(`/conversation/conversation/archive/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}`, { method: 'POST' });
}

/**
 * Restores an archived conversation.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @returns {Promise<import('./conversationTypes.js').ConversationDto>}
 */
export async function restoreConversation(projectId, conversationId) {
  return apiRequest(`/conversation/conversation/restore/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}`, { method: 'POST' });
}

/**
 * Soft-deletes a conversation.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @returns {Promise<void>}
 */
export async function deleteConversation(projectId, conversationId) {
  await apiRequest(`/conversation/conversation/delete/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}`, { method: 'DELETE' });
}
