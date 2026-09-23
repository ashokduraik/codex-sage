/**
 * Conversation and message DTO helpers.
 */

/**
 * Formats a date as ISO-8601, or empty string when missing.
 * @param {unknown} value Date or string.
 * @returns {string}
 */
function toIsoOrEmpty(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value ?? '');
}

/**
 * Formats a date as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

/**
 * Maps a conversation row to the create/get/patch header.
 * @param {object} conversation Conversation document or lean object.
 * @returns {object}
 */
export function mapConversationToDto(conversation) {
  return {
    id: String(conversation._id ?? conversation.id),
    projectId: String(conversation.projectId),
    title: conversation.title,
    titleSource: conversation.titleSource,
    lifecycleStatus: conversation.lifecycleStatus,
    ownerUserId: String(conversation.ownerUserId),
    messageCount: conversation.messageCount ?? 0,
    lastMessageAt: toIsoOrNull(conversation.lastMessageAt),
    archivedAt: toIsoOrNull(conversation.archivedAt),
    createdAt: toIsoOrEmpty(conversation.createdAt),
    updatedAt: toIsoOrEmpty(conversation.updatedAt),
  };
}

/**
 * Maps a conversation row to the list item (no ownerUserId).
 * @param {object} conversation Conversation document or lean object.
 * @returns {object}
 */
export function mapConversationToListDto(conversation) {
  return {
    id: String(conversation._id ?? conversation.id),
    title: conversation.title,
    lifecycleStatus: conversation.lifecycleStatus,
    messageCount: conversation.messageCount ?? 0,
    lastMessageAt: toIsoOrNull(conversation.lastMessageAt),
    updatedAt: toIsoOrEmpty(conversation.updatedAt),
  };
}

/**
 * Maps a message row to the thread list item. Null reserved fields are omitted.
 * @param {object} message Message document or lean object.
 * @returns {object}
 */
export function mapMessageToDto(message) {
  /** @type {Record<string, unknown>} */
  const dto = {
    id: String(message._id ?? message.id),
    role: message.role,
    content: message.content,
    messageStatus: message.messageStatus,
    createdAt: toIsoOrEmpty(message.createdAt),
  };
  if (message.evidence != null) {
    dto.evidence = message.evidence;
  }
  if (message.usage != null) {
    dto.usage = message.usage;
  }
  if (message.contextMetrics != null) {
    dto.contextMetrics = message.contextMetrics;
  }
  return dto;
}

/**
 * Maps a conversation row to a search hit with a snippet.
 * @param {object} conversation Conversation document or lean object.
 * @param {string} snippet Plain-text snippet.
 * @returns {object}
 */
export function mapConversationToSearchDto(conversation, snippet) {
  return {
    id: String(conversation._id ?? conversation.id),
    title: conversation.title,
    snippet,
    updatedAt: toIsoOrEmpty(conversation.updatedAt),
    titleSource: conversation.titleSource,
  };
}
