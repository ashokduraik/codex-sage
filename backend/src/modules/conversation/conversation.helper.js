/**
 * conversation/conversation.helper.js — merged resource file.
 */
import {
  CONVERSATION_LIFECYCLE_STATUS_VALUES,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TITLE_SOURCE_VALUES,
  Conversation,
} from '../../models/conversations.model.js';
import { MESSAGE_ROLE_VALUES, MESSAGE_STATUS_VALUES, Message } from '../../models/messages.model.js';
import { assertOrgId, decodeCursor, encodeCursor, softDelete, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import mongoose from 'mongoose';

// --- from conversations/conversations.constants.js ---
/**
 * Named limits for conversation list, messages, titles, and search.
 */

/** Default page size for conversation lists. */
export const CONVERSATIONS_LIST_DEFAULT_LIMIT = 20;

/** Upper bound for conversation list pages. */
export const CONVERSATIONS_LIST_MAX_LIMIT = 100;

/** Default page size for message lists. */
export const MESSAGES_LIST_DEFAULT_LIMIT = 50;

/** Upper bound for message list pages. */
export const MESSAGES_LIST_MAX_LIMIT = 200;

export {
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_LIFECYCLE_STATUS_VALUES,
  CONVERSATION_TITLE_SOURCE_VALUES,
  MESSAGE_ROLE_VALUES,
  MESSAGE_STATUS_VALUES,
};

/** Maximum stored conversation title length (see model). */

/** Placeholder title until the user renames or auto-title runs. */
export const CONVERSATION_DEFAULT_TITLE = 'New conversation';

/** Minimum search query length. */
export const CONVERSATION_SEARCH_MIN_QUERY_LENGTH = 2;

/** Default search page size. */
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 20;

/** Maximum search page size. */
export const CONVERSATION_SEARCH_MAX_LIMIT = 100;

/** Snippet character cap (plain text, no highlight markers). */
export const CONVERSATION_SEARCH_SNIPPET_MAX_CHARS = 160;

/** Cap for denormalized message text on the conversation row. */
export const CONVERSATION_SEARCH_TEXT_MAX_CHARS = 8000;

/** Cap for a future LLM auto-title prompt (Phase 45). */
export const CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS = 500;

/** Interim title from the first user message when titleSource is still default. */
export const CONVERSATION_TRUNCATED_TITLE_MAX_CHARS = 60;

// --- from conversations/conversations.repository.js ---
/**
 * Conversation and message repository — org + project + owner scoped.
 */
/**
 * Builds the tenant + owner filter used by every conversation read.
 * `conversations.view` does not expand this set.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId Conversation owner.
 * @returns {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId,
 *   ownerUserId: import('mongoose').Types.ObjectId,
 *   status: string,
 * }}
 */
export function buildOwnConversationFilter(orgId, projectId, userId) {
  return {
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    ownerUserId: new mongoose.Types.ObjectId(String(userId)),
    status: ROW_STATUS_ACTIVE,
  };
}

/**
 * Clamps a conversation list page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampConversationsListLimit(limit) {
  return clampLimit(limit, CONVERSATIONS_LIST_DEFAULT_LIMIT, CONVERSATIONS_LIST_MAX_LIMIT);
}

/**
 * Clamps a message list page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampMessagesListLimit(limit) {
  return clampLimit(limit, MESSAGES_LIST_DEFAULT_LIMIT, MESSAGES_LIST_MAX_LIMIT);
}

/**
 * Clamps a search page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampConversationSearchLimit(limit) {
  return clampLimit(limit, CONVERSATION_SEARCH_DEFAULT_LIMIT, CONVERSATION_SEARCH_MAX_LIMIT);
}

/**
 * Clamps a requested page size into a range.
 * @param {unknown} limit Raw limit.
 * @param {number} defaultLimit Default when missing or invalid.
 * @param {number} maxLimit Upper bound.
 * @returns {number}
 */
function clampLimit(limit, defaultLimit, maxLimit) {
  if (limit === undefined || limit === null || limit === '') {
    return defaultLimit;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultLimit;
  }
  return Math.min(Math.floor(parsed), maxLimit);
}

/**
 * Builds a descending keyset filter on a timestamp field plus `_id`.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @param {string} stampField Timestamp field name.
 * @returns {object}
 */
function keysetAfterDescending(cursor, stampField) {
  const stamp = new Date(cursor.t);
  if (Number.isNaN(stamp.getTime()) || !mongoose.isValidObjectId(cursor.i)) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  const id = new mongoose.Types.ObjectId(cursor.i);
  return {
    $or: [{ [stampField]: { $lt: stamp } }, { [stampField]: stamp, _id: { $lt: id } }],
  };
}

/**
 * Encodes the next-page cursor from a row timestamp.
 * @param {object} row Document with timestamp and `_id`.
 * @param {string} stampField Timestamp field name.
 * @returns {string}
 */
function encodeRowCursor(row, stampField) {
  const stamp = row[stampField];
  return encodeCursor({
    t: stamp instanceof Date ? stamp.toISOString() : String(stamp),
    i: String(row._id),
  });
}

/**
 * Inserts an active conversation owned by the caller.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   ownerUserId: import('mongoose').Types.ObjectId | string,
 *   title?: string,
 *   titleSource?: string,
 * }} input Create fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function insertConversation(input, options = {}) {
  assertOrgId(input.orgId);
  const title = input.title && input.title.length > 0 ? input.title : CONVERSATION_DEFAULT_TITLE;
  const titleSource = input.titleSource ?? (input.title ? 'user' : 'default');
  const [created] = await Conversation.create(
    [
      {
        orgId: input.orgId,
        projectId: input.projectId,
        ownerUserId: input.ownerUserId,
        title,
        titleSource,
        searchText: '',
        lifecycleStatus: 'active',
        archivedAt: null,
        lastMessageAt: null,
        messageCount: 0,
        createdBy: input.ownerUserId,
        updatedBy: input.ownerUserId,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return created;
}

/**
 * Finds one active conversation in a project (internal loaders; not HTTP).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findConversationInProject(orgId, projectId, conversationId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(conversationId)) {
    return null;
  }
  return Conversation.findOne({
    _id: new mongoose.Types.ObjectId(String(conversationId)),
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * Finds one active conversation the caller owns.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {import('mongoose').Types.ObjectId | string} userId Owner user id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findOwnConversation(orgId, projectId, conversationId, userId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(conversationId)) {
    return null;
  }
  return Conversation.findOne({
    ...buildOwnConversationFilter(orgId, projectId, userId),
    _id: new mongoose.Types.ObjectId(String(conversationId)),
  }).exec();
}

/**
 * Lists the caller's conversations with keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId Owner user id.
 * @param {{ cursor?: string, limit?: unknown, archived?: boolean }} [filters] List filters.
 * @returns {Promise<{ items: import('mongoose').Document[], nextCursor: string | null }>}
 */
export async function listOwnConversations(orgId, projectId, userId, filters = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return { items: [], nextCursor: null };
  }

  const limit = clampConversationsListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = {
    ...buildOwnConversationFilter(orgId, projectId, userId),
    lifecycleStatus: filters.archived === true ? 'archived' : 'active',
  };
  if (filters.cursor) {
    Object.assign(query, keysetAfterDescending(decodeCursor(filters.cursor), 'updatedAt'));
  }

  const rows = await Conversation.find(query)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? encodeRowCursor(items[items.length - 1], 'updatedAt') : null;
  return { items, nextCursor };
}

/**
 * Archives an active conversation the caller owns.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   userId: import('mongoose').Types.ObjectId | string,
 * }} input Archive keys.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function archiveOwnConversation(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId)) {
    return null;
  }
  const now = new Date();
  return Conversation.findOneAndUpdate(
    {
      ...buildOwnConversationFilter(input.orgId, input.projectId, input.userId),
      _id: new mongoose.Types.ObjectId(String(input.conversationId)),
      lifecycleStatus: 'active',
    },
    {
      $set: {
        lifecycleStatus: 'archived',
        archivedAt: now,
        updatedBy: input.userId,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Restores an archived conversation the caller owns.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   userId: import('mongoose').Types.ObjectId | string,
 * }} input Restore keys.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function restoreOwnConversation(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId)) {
    return null;
  }
  const now = new Date();
  return Conversation.findOneAndUpdate(
    {
      ...buildOwnConversationFilter(input.orgId, input.projectId, input.userId),
      _id: new mongoose.Types.ObjectId(String(input.conversationId)),
      lifecycleStatus: 'archived',
    },
    {
      $set: {
        lifecycleStatus: 'active',
        archivedAt: null,
        updatedBy: input.userId,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Soft-deletes a conversation the caller owns.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   userId: import('mongoose').Types.ObjectId | string,
 * }} input Delete keys.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteOwnConversation(input, options = {}) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId)) {
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  }
  return softDelete(
    Conversation,
    {
      ...buildOwnConversationFilter(input.orgId, input.projectId, input.userId),
      _id: new mongoose.Types.ObjectId(String(input.conversationId)),
    },
    { updatedBy: input.userId, session: options.session },
  );
}

/**
 * Updates title and titleSource on an owned conversation.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   userId?: import('mongoose').Types.ObjectId | string | null,
 *   title: string,
 *   titleSource: string,
 * }} input Title fields.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function updateConversationTitleFields(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId)) {
    return null;
  }
  /** @type {Record<string, unknown>} */
  const filter = {
    _id: new mongoose.Types.ObjectId(String(input.conversationId)),
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    status: ROW_STATUS_ACTIVE,
  };
  if (input.userId) {
    filter.ownerUserId = new mongoose.Types.ObjectId(String(input.userId));
  }
  return Conversation.findOneAndUpdate(
    filter,
    {
      $set: {
        title: input.title,
        titleSource: input.titleSource,
        updatedBy: input.userId ?? null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Lists messages for a conversation oldest-first with keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {{ cursor?: string, limit?: unknown }} [filters] Page filters.
 * @returns {Promise<{ items: import('mongoose').Document[], nextCursor: string | null }>}
 */
export async function listMessagesForConversation(orgId, projectId, conversationId, filters = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(conversationId)) {
    return { items: [], nextCursor: null };
  }
  const limit = clampMessagesListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = {
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    conversationId: new mongoose.Types.ObjectId(String(conversationId)),
    status: ROW_STATUS_ACTIVE,
  };
  if (filters.cursor) {
    Object.assign(query, keysetAfterAscending(decodeCursor(filters.cursor), 'createdAt'));
  }
  const rows = await Message.find(query)
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit + 1)
    .exec();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? encodeRowCursor(items[items.length - 1], 'createdAt') : null;
  return { items, nextCursor };

  /**
   * Builds an ascending keyset filter on a timestamp field plus `_id`.
   * @param {{ t: string, i: string }} cursor Decoded cursor.
   * @param {string} stampField Timestamp field name.
   * @returns {object}
   */
  function keysetAfterAscending(cursor, stampField) {
    const stamp = new Date(cursor.t);
    if (Number.isNaN(stamp.getTime()) || !mongoose.isValidObjectId(cursor.i)) {
      throw ApiError.fromCode('INVALID_CURSOR');
    }
    const id = new mongoose.Types.ObjectId(cursor.i);
    return {
      $or: [{ [stampField]: { $gt: stamp } }, { [stampField]: stamp, _id: { $gt: id } }],
    };
  }
}

/**
 * Returns the most recent messages in chronological order.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {number} [limit] Max rows.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listRecentMessages(orgId, projectId, conversationId, limit) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(conversationId)) {
    return [];
  }
  const pageSize = clampMessagesListLimit(limit);
  const rows = await Message.find({
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    conversationId: new mongoose.Types.ObjectId(String(conversationId)),
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(pageSize)
    .exec();
  return rows.reverse();
}

/**
 * Rebuilds denormalized `searchText` from active message contents.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 * }} input Scope.
 * @returns {Promise<string>}
 */
export async function refreshConversationSearchText(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId)) {
    return '';
  }
  const messages = await Message.find({
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
    status: ROW_STATUS_ACTIVE,
  })
    .select({ content: 1 })
    .sort({ createdAt: 1, _id: 1 })
    .lean()
    .exec();

  let searchText = '';
  for (const message of messages) {
    const piece = typeof message.content === 'string' ? message.content : '';
    if (!piece) {
      continue;
    }
    const separator = searchText ? '\n' : '';
    const remaining = CONVERSATION_SEARCH_TEXT_MAX_CHARS - searchText.length - separator.length;
    if (remaining <= 0) {
      break;
    }
    searchText += separator + (piece.length > remaining ? piece.slice(0, remaining) : piece);
  }

  await Conversation.updateOne(
    {
      _id: new mongoose.Types.ObjectId(String(input.conversationId)),
      orgId: input.orgId,
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      status: ROW_STATUS_ACTIVE,
    },
    { $set: { searchText } },
  );
  return searchText;
}

/**
 * Text-searches the caller's conversations.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   userId: import('mongoose').Types.ObjectId | string,
 *   q: string,
 *   cursor?: string,
 *   limit?: unknown,
 *   archived?: boolean,
 * }} input Search inputs.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function searchOwnConversations(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId)) {
    return { items: [], nextCursor: null };
  }
  const limit = clampConversationSearchLimit(input.limit);
  /** @type {Record<string, unknown>} */
  const query = {
    ...buildOwnConversationFilter(input.orgId, input.projectId, input.userId),
    lifecycleStatus: input.archived === true ? 'archived' : 'active',
    $text: { $search: input.q },
  };
  if (input.cursor) {
    const keyset = keysetAfterDescending(decodeCursor(input.cursor), 'updatedAt');
    delete query.$text;
    query.$and = [{ $text: { $search: input.q } }, keyset];
  }

  const rows = await Conversation.find(query)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()
    .exec();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? encodeRowCursor(items[items.length - 1], 'updatedAt') : null;
  return { items, nextCursor };
}
