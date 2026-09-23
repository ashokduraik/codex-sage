/**
 * Conversation use cases — audit, counts, owner-only visibility.
 */
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { adjustProjectConversationCount } from '../projects/index.js';
import {
  CONVERSATION_DEFAULT_TITLE,
  CONVERSATION_TITLE_MAX_LENGTH,
} from './conversations.constants.js';
import {
  assertConversationArchiveAllowed,
  assertConversationRestoreAllowed,
  assertConversationWritable,
} from './conversations.lifecycle.js';
import {
  archiveOwnConversation,
  findOwnConversation,
  insertConversation,
  listMessagesForConversation,
  listOwnConversations,
  listRecentMessages as listRecentMessagesInRepo,
  restoreOwnConversation,
  searchOwnConversations,
  softDeleteOwnConversation,
  updateConversationTitleFields,
} from './conversations.repository.js';
import { parseConversationSearchQuery, buildConversationSnippet } from './conversations.search.js';
import {
  mapConversationToDto,
  mapConversationToListDto,
  mapConversationToSearchDto,
  mapMessageToDto,
} from './conversations.types.js';

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

export { assertConversationWritable, CONVERSATION_DEFAULT_TITLE };
