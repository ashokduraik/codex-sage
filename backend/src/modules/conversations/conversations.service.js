/**
 * Conversation use cases — audit, counts, owner-only visibility.
 */
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { adjustProjectConversationCount } from '../projects/index.js';
import {
  CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS,
  CONVERSATION_DEFAULT_TITLE,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  CONVERSATION_SEARCH_SNIPPET_MAX_CHARS,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TRUNCATED_TITLE_MAX_CHARS,
} from './conversations.constants.js';
import {
  archiveOwnConversation,
  findConversationInProject,
  findOwnConversation,
  insertConversation,
  listMessagesForConversation,
  listOwnConversations,
  listRecentMessages as listRecentMessagesInRepo,
  refreshConversationSearchText,
  restoreOwnConversation,
  searchOwnConversations,
  softDeleteOwnConversation,
  updateConversationTitleFields,
} from './conversations.repository.js';

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

/**
 * Throws when an archived conversation cannot accept writes (Phase 50).
 * Cross-owner and missing rows are 404, not 403.
 * @param {object | null | undefined} conversation Loaded conversation row.
 * @param {import('mongoose').Types.ObjectId | string} userId Caller user id.
 * @throws {import('../../platform/errors.js').ApiError}
 */
export function assertConversationWritable(conversation, userId) {
  if (!conversation) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  if (String(conversation.ownerUserId) !== String(userId)) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  if (conversation.lifecycleStatus !== 'active') {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'write' },
    });
  }
}

/**
 * Throws unless the conversation can move to archived.
 * @param {object} conversation Loaded conversation row.
 * @throws {import('../../platform/errors.js').ApiError} INVALID_STATE_TRANSITION
 */
export function assertConversationArchiveAllowed(conversation) {
  if (conversation.lifecycleStatus !== 'active') {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'archived' },
    });
  }
}

/**
 * Throws unless the conversation can move back to active.
 * @param {object} conversation Loaded conversation row.
 * @throws {import('../../platform/errors.js').ApiError} INVALID_STATE_TRANSITION
 */
export function assertConversationRestoreAllowed(conversation) {
  if (conversation.lifecycleStatus !== 'archived') {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'active' },
    });
  }
}

/**
 * Normalizes and validates a search query string.
 * @param {unknown} raw Raw `q` value.
 * @returns {string}
 * @throws {import('../../platform/errors.js').ApiError} VALIDATION_ERROR
 */
export function parseConversationSearchQuery(raw) {
  if (typeof raw !== 'string') {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'q', message: 'q is required' }],
    });
  }
  const query = raw.trim();
  if (query.length < CONVERSATION_SEARCH_MIN_QUERY_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'q',
          message: `q must be at least ${CONVERSATION_SEARCH_MIN_QUERY_LENGTH} characters`,
        },
      ],
    });
  }
  return query;
}

/**
 * Builds a plain-text snippet from title or searchText, capped and ellipsized.
 * @param {{ title?: string, searchText?: string }} conversation Conversation fields.
 * @param {string} query Search query.
 * @param {number} [maxChars] Snippet cap.
 * @returns {string}
 */
export function buildConversationSnippet(conversation, query, maxChars) {
  const cap = maxChars ?? CONVERSATION_SEARCH_SNIPPET_MAX_CHARS;
  const title = typeof conversation.title === 'string' ? conversation.title : '';
  const searchText = typeof conversation.searchText === 'string' ? conversation.searchText : '';
  const needle = query.toLowerCase();
  const source = title.toLowerCase().includes(needle) ? title : searchText || title;
  if (source.length <= cap) {
    return source;
  }
  if (cap <= 3) {
    return source.slice(0, cap);
  }
  return `${source.slice(0, cap - 3)}...`;
}

/**
 * Truncates user text into a title-safe string.
 * @param {string} text Source text.
 * @param {number} maxChars Cap.
 * @returns {string}
 */
export function truncateUserTextTitle(text, maxChars) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return collapsed.slice(0, maxChars).trimEnd();
}

/**
 * Sets a truncated first-user-message title when the row still has the default title.
 * Does not call a model. Missing rows and non-default titles are no-ops so `done` is never blocked.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   firstUserContent?: string,
 *   assistantMessageId?: string,
 * }} input Auto-title inputs.
 * @returns {Promise<void>}
 */
export async function scheduleConversationAutoTitle(input) {
  const raw =
    typeof input.firstUserContent === 'string'
      ? input.firstUserContent.slice(0, CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS)
      : '';
  const title = truncateUserTextTitle(raw, CONVERSATION_TRUNCATED_TITLE_MAX_CHARS);
  if (!title) {
    return;
  }

  const conversation = await findConversationInProject(
    input.orgId,
    input.projectId,
    input.conversationId,
  );
  if (!conversation || conversation.titleSource !== 'default') {
    return;
  }

  await updateConversationTitleFields({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    title,
    titleSource: 'truncated_user_text',
  });
  await refreshConversationSearchText({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
  });
}

/**
 * Loads a conversation the caller owns or throws CONVERSATION_NOT_FOUND.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} userId Caller user id.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function loadConversationForUser(orgId, projectId, conversationId, userId) {
  const conversation = await findOwnConversation(orgId, projectId, conversationId, userId);
  if (!conversation) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  return conversation;
}

/**
 * Creates a conversation and increments the project count.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   title?: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Create inputs.
 * @returns {Promise<object>}
 */
export async function createConversation(input) {
  const created = await insertConversation({
    orgId: input.orgId,
    projectId: input.projectId,
    ownerUserId: input.actorUserId,
    title: input.title,
    titleSource: input.title ? 'user' : 'default',
  });
  await adjustProjectConversationCount(input.orgId, input.projectId, 1);
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.created',
      resourceType: 'conversation',
      resourceId: String(created._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        projectId: input.projectId,
        conversationId: String(created._id),
        titleLength: created.title.length,
      },
    },
    { log: input.log },
  );
  return mapConversationToDto(created);
}

/**
 * Lists the caller's conversations.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} userId Caller user id.
 * @param {{ cursor?: string, limit?: unknown, archived?: boolean }} [filters] List filters.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function listConversations(orgId, projectId, userId, filters = {}) {
  const page = await listOwnConversations(orgId, projectId, userId, filters);
  return {
    items: page.items.map(mapConversationToListDto),
    nextCursor: page.nextCursor,
  };
}

/**
 * Returns one conversation header the caller owns.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} userId Caller user id.
 * @returns {Promise<object>}
 */
export async function getConversation(orgId, projectId, conversationId, userId) {
  const conversation = await loadConversationForUser(orgId, projectId, conversationId, userId);
  return mapConversationToDto(conversation);
}

/**
 * Lists messages after confirming the caller owns the conversation.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} userId Caller user id.
 * @param {{ cursor?: string, limit?: unknown }} [filters] Page filters.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function listConversationMessages(
  orgId,
  projectId,
  conversationId,
  userId,
  filters = {},
) {
  await loadConversationForUser(orgId, projectId, conversationId, userId);
  const page = await listMessagesForConversation(orgId, projectId, conversationId, filters);
  return {
    items: page.items.map(mapMessageToDto),
    nextCursor: page.nextCursor,
  };
}

/**
 * Recent messages for later context phases (conversation must already be authorized).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {number} [limit] Max rows.
 * @returns {Promise<object[]>}
 */
export async function listRecentMessages(orgId, projectId, conversationId, limit) {
  const rows = await listRecentMessagesInRepo(orgId, projectId, conversationId, limit);
  return rows.map(mapMessageToDto);
}

/**
 * Archives an owned conversation.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Archive inputs.
 * @returns {Promise<object>}
 */
export async function archiveConversation(input) {
  const conversation = await loadConversationForUser(
    input.orgId,
    input.projectId,
    input.conversationId,
    input.actorUserId,
  );
  assertConversationArchiveAllowed(conversation);
  const updated = await archiveOwnConversation({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    userId: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'archived' },
    });
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.archived',
      resourceType: 'conversation',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { projectId: input.projectId, conversationId: String(updated._id) },
    },
    { log: input.log },
  );
  return mapConversationToDto(updated);
}

/**
 * Restores an owned archived conversation.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Restore inputs.
 * @returns {Promise<object>}
 */
export async function restoreConversation(input) {
  const conversation = await loadConversationForUser(
    input.orgId,
    input.projectId,
    input.conversationId,
    input.actorUserId,
  );
  assertConversationRestoreAllowed(conversation);
  const updated = await restoreOwnConversation({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    userId: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'active' },
    });
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.restored',
      resourceType: 'conversation',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { projectId: input.projectId, conversationId: String(updated._id) },
    },
    { log: input.log },
  );
  return mapConversationToDto(updated);
}

/**
 * Soft-deletes an owned conversation and decrements the project count.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Delete inputs.
 * @returns {Promise<void>}
 */
export async function deleteConversation(input) {
  await loadConversationForUser(
    input.orgId,
    input.projectId,
    input.conversationId,
    input.actorUserId,
  );
  const result = await softDeleteOwnConversation({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    userId: input.actorUserId,
  });
  if (!result.modifiedCount) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  await adjustProjectConversationCount(input.orgId, input.projectId, -1);
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.deleted',
      resourceType: 'conversation',
      resourceId: input.conversationId,
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { projectId: input.projectId, conversationId: input.conversationId },
    },
    { log: input.log },
  );
}

/**
 * Renames an owned conversation and records title lengths only.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   title: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Patch inputs.
 * @returns {Promise<object>}
 */
export async function updateConversationTitle(input) {
  const conversation = await loadConversationForUser(
    input.orgId,
    input.projectId,
    input.conversationId,
    input.actorUserId,
  );
  const title = input.title.trim();
  if (!title || title.length > CONVERSATION_TITLE_MAX_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'title',
          message: `title must be 1–${CONVERSATION_TITLE_MAX_LENGTH} characters`,
        },
      ],
    });
  }
  const updated = await updateConversationTitleFields({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    userId: input.actorUserId,
    title,
    titleSource: 'user',
  });
  if (!updated) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.title_changed',
      resourceType: 'conversation',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        projectId: input.projectId,
        conversationId: String(updated._id),
        oldTitleLength: conversation.title.length,
        newTitleLength: title.length,
      },
    },
    { log: input.log },
  );
  return mapConversationToDto(updated);
}

/**
 * Searches the caller's conversations by title and message searchText.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   userId: string,
 *   q: unknown,
 *   cursor?: string,
 *   limit?: unknown,
 *   archived?: boolean,
 * }} input Search inputs.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function searchConversations(input) {
  const q = parseConversationSearchQuery(input.q);
  const page = await searchOwnConversations({
    orgId: input.orgId,
    projectId: input.projectId,
    userId: input.userId,
    q,
    cursor: input.cursor,
    limit: input.limit,
    archived: input.archived,
  });
  return {
    items: page.items.map((row) =>
      mapConversationToSearchDto(row, buildConversationSnippet(row, q)),
    ),
    nextCursor: page.nextCursor,
  };
}

export { CONVERSATION_DEFAULT_TITLE };
