/**
 * conversation/conversation.helper.js — merged resource file.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { recordProjectActivity } from '../masters/index.js';
import { Message, MESSAGE_ROLE_VALUES, MESSAGE_STATUS_VALUES, MESSAGE_SUPPORT_LEVEL_VALUES } from '../../models/messages.model.js';
import { assertOrgId, decodeCursor, encodeCursor, softDelete, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import {
  Conversation,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TITLE_SOURCE_VALUES,
  CONVERSATION_LIFECYCLE_STATUS_VALUES,
} from '../../models/conversations.model.js';

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
  MESSAGE_SUPPORT_LEVEL_VALUES,
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
 * Clamps a message list page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampMessagesListLimit(limit) {
  return clampLimit(limit, MESSAGES_LIST_DEFAULT_LIMIT, MESSAGES_LIST_MAX_LIMIT);
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

  const limit = clampLimit(filters.limit, CONVERSATIONS_LIST_DEFAULT_LIMIT, CONVERSATIONS_LIST_MAX_LIMIT);
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
  const limit = clampLimit(input.limit, CONVERSATION_SEARCH_DEFAULT_LIMIT, CONVERSATION_SEARCH_MAX_LIMIT);
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
 * Inserts the user question and a pending assistant placeholder in one transaction.
 * Bumps conversation `messageCount` by 2 and sets `lastMessageAt`.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   content: string,
 *   knowledgeVersionId?: string | null,
 * }} input Turn fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session (tests).
 * @returns {Promise<{ userMessage: import('mongoose').Document, assistantMessage: import('mongoose').Document }>}
 * @throws {import('../../platform/errors.js').ApiError} When ids are invalid.
 */
export async function insertChatTurnPair(input, options = {}) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId) || !mongoose.isValidObjectId(input.actorUserId)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'conversationId', message: 'org/project/conversation/actor ids must be valid ObjectIds' }],
    });
  }

  const orgId = input.orgId;
  const projectId = new mongoose.Types.ObjectId(String(input.projectId));
  const conversationId = new mongoose.Types.ObjectId(String(input.conversationId));
  const actorUserId = new mongoose.Types.ObjectId(String(input.actorUserId));
  const knowledgeVersionId =
    input.knowledgeVersionId && mongoose.isValidObjectId(input.knowledgeVersionId)
      ? new mongoose.Types.ObjectId(String(input.knowledgeVersionId))
      : null;
  const now = new Date();

  const runInsert = async (session) => {
    const userDocs = [
      {
        orgId,
        projectId,
        conversationId,
        role: 'user',
        content: input.content,
        messageStatus: 'accepted',
        knowledgeVersionId,
        parentMessageId: null,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      },
    ];
    // Mongoose String `required` rejects ''; use ZWSP until DRAFT/VERIFY finalize overwrites.
    const assistantDocs = [
      {
        orgId,
        projectId,
        conversationId,
        role: 'assistant',
        content: '\u200b',
        messageStatus: 'generating',
        knowledgeVersionId,
        parentMessageId: null,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      },
    ];
    const [userMessage] = session ? await Message.create(userDocs, { session }) : await Message.create(userDocs);
    assistantDocs[0].parentMessageId = userMessage._id;
    const [assistantMessage] = session ? await Message.create(assistantDocs, { session }) : await Message.create(assistantDocs);
    const update = Conversation.updateOne(
      {
        _id: conversationId,
        orgId,
        projectId,
        status: ROW_STATUS_ACTIVE,
      },
      {
        $inc: { messageCount: 2 },
        $set: { lastMessageAt: now, updatedBy: actorUserId },
      },
    );
    if (session) {
      update.session(session);
    }
    await update.exec();
    return { userMessage, assistantMessage };
  };

  if (options.session) {
    return runInsert(options.session);
  }

  const mongoSession = await mongoose.startSession();
  try {
    /** @type {{ userMessage: import('mongoose').Document, assistantMessage: import('mongoose').Document } | undefined} */
    let pair;
    await mongoSession.withTransaction(async () => {
      pair = await runInsert(mongoSession);
    });
    if (!pair) {
      throw ApiError.fromCode('INTERNAL_ERROR');
    }
    return pair;
  } finally {
    await mongoSession.endSession();
  }
}

/**
 * Finalizes a pending assistant message after DRAFT/VERIFY (phase 49).
 * Updates the existing row identified by assistantMessageId — never inserts a second turn.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   assistantMessageId: string,
 *   content: string,
 *   messageStatus: string,
 *   evidence?: unknown,
 *   supportLevel?: string | null,
 *   usage?: object | null,
 *   durationMs?: number | null,
 *   modelId?: string | null,
 *   contextMetrics?: object | null,
 *   knowledgeVersionId?: string | null,
 *   trace?: object | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 * }} input Finalize fields.
 * @returns {Promise<import('mongoose').Document>}
 * @throws {import('../../platform/errors.js').ApiError} When the pending row is missing or ids are invalid.
 */
export async function finalizeAssistantMessage(input) {
  assertOrgId(input.orgId);
  if (
    !mongoose.isValidObjectId(input.projectId) ||
    !mongoose.isValidObjectId(input.conversationId) ||
    !mongoose.isValidObjectId(input.assistantMessageId)
  ) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'assistantMessageId', message: 'org/project/conversation/assistant ids must be valid ObjectIds' }],
    });
  }
  if (!MESSAGE_STATUS_VALUES.includes(input.messageStatus)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'messageStatus', message: 'invalid messageStatus' }],
    });
  }
  if (input.supportLevel != null && !MESSAGE_SUPPORT_LEVEL_VALUES.includes(input.supportLevel)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'supportLevel', message: 'invalid supportLevel' }],
    });
  }

  /** @type {Record<string, unknown>} */
  const $set = {
    content: typeof input.content === 'string' ? input.content : '',
    messageStatus: input.messageStatus,
    evidence: input.evidence ?? null,
    supportLevel: input.supportLevel ?? null,
    usage: input.usage ?? null,
    durationMs: Number.isFinite(input.durationMs) ? input.durationMs : null,
    modelId: typeof input.modelId === 'string' && input.modelId !== '' ? input.modelId : null,
    contextMetrics: input.contextMetrics ?? null,
    knowledgeVersionId:
      input.knowledgeVersionId && mongoose.isValidObjectId(input.knowledgeVersionId)
        ? new mongoose.Types.ObjectId(String(input.knowledgeVersionId))
        : null,
    trace: input.trace ?? null,
  };
  if (input.updatedBy && mongoose.isValidObjectId(input.updatedBy)) {
    $set.updatedBy = new mongoose.Types.ObjectId(String(input.updatedBy));
  }

  const updated = await Message.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.assistantMessageId)),
      orgId: input.orgId,
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
      role: 'assistant',
      status: ROW_STATUS_ACTIVE,
    },
    { $set },
    { returnDocument: 'after' },
  ).exec();

  if (!updated) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }

  await Conversation.updateOne(
    {
      _id: new mongoose.Types.ObjectId(String(input.conversationId)),
      orgId: input.orgId,
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      status: ROW_STATUS_ACTIVE,
    },
    { $set: { lastMessageAt: updated.updatedAt ?? new Date() } },
  ).exec();

  if (input.messageStatus === 'completed') {
    await recordCompletedAssistantUsageActivities({
      orgId: String(input.orgId),
      projectId: String(input.projectId),
      conversationId: String(input.conversationId),
      messageId: String(input.assistantMessageId),
      userId: input.updatedBy && mongoose.isValidObjectId(input.updatedBy) ? String(input.updatedBy) : null,
      usage: input.usage,
    });
  }

  return updated;

  /**
   * Appends question/token projectActivities after a completed assistant answer.
   * Best-effort via recordProjectActivity — never throws to finalize.
   * @param {{
   *   orgId: string,
   *   projectId: string,
   *   conversationId: string,
   *   messageId: string,
   *   userId: string | null,
   *   usage?: { inputTokens?: number | null, outputTokens?: number | null } | null,
   * }} activityInput Scope and optional SDK usage.
   * @returns {Promise<void>}
   */
  async function recordCompletedAssistantUsageActivities(activityInput) {
    const messageId = activityInput.messageId;
    await recordProjectActivity({
      orgId: activityInput.orgId,
      projectId: activityInput.projectId,
      userId: activityInput.userId,
      kind: 'question.answered',
      quantity: 1,
      unit: 'count',
      sourceRef: JSON.stringify({
        messageId,
        conversationId: activityInput.conversationId,
      }),
      dedupeKey: `question.answered:${messageId}`,
    });
    const inputTokens = activityInput.usage?.inputTokens;
    if (Number.isFinite(inputTokens)) {
      await recordProjectActivity({
        orgId: activityInput.orgId,
        projectId: activityInput.projectId,
        userId: activityInput.userId,
        kind: 'tokens.input',
        quantity: inputTokens,
        unit: 'tokens',
        sourceRef: messageId,
        dedupeKey: `tokens.input:${messageId}`,
      });
    }
    const outputTokens = activityInput.usage?.outputTokens;
    if (Number.isFinite(outputTokens)) {
      await recordProjectActivity({
        orgId: activityInput.orgId,
        projectId: activityInput.projectId,
        userId: activityInput.userId,
        kind: 'tokens.output',
        quantity: outputTokens,
        unit: 'tokens',
        sourceRef: messageId,
        dedupeKey: `tokens.output:${messageId}`,
      });
    }
  }
}

/**
 * Persists a user-only message in `queued` state while knowledge is updating.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   content: string,
 *   blockingJobId?: string | null,
 *   queuedAt: Date,
 *   expiresAt: Date,
 * }} input Queue insert fields.
 * @returns {Promise<import('mongoose').Document>}
 * @throws {import('../../platform/errors.js').ApiError} When ids are invalid.
 */
export async function insertQueuedUserMessage(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId) || !mongoose.isValidObjectId(input.actorUserId)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'conversationId', message: 'org/project/conversation/actor ids must be valid ObjectIds' }],
    });
  }

  const orgId = input.orgId;
  const projectId = new mongoose.Types.ObjectId(String(input.projectId));
  const conversationId = new mongoose.Types.ObjectId(String(input.conversationId));
  const actorUserId = new mongoose.Types.ObjectId(String(input.actorUserId));
  const blockingJobId =
    input.blockingJobId && mongoose.isValidObjectId(input.blockingJobId) ? new mongoose.Types.ObjectId(String(input.blockingJobId)) : null;

  const [userMessage] = await Message.create([
    {
      orgId,
      projectId,
      conversationId,
      role: 'user',
      content: input.content,
      messageStatus: 'queued',
      knowledgeVersionId: null,
      parentMessageId: null,
      queuedAt: input.queuedAt,
      expiresAt: input.expiresAt,
      blockingJobId,
      queueFailureCode: null,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    },
  ]);

  await Conversation.updateOne(
    {
      _id: conversationId,
      orgId,
      projectId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $inc: { messageCount: 1 },
      $set: { lastMessageAt: input.queuedAt, updatedBy: actorUserId },
    },
  ).exec();

  return userMessage;
}

/**
 * Lists unexpired queued user messages for a project in FIFO order.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   now: Date,
 *   limit: number,
 * }} input Query scope.
 * @returns {Promise<object[]>}
 */
export async function listUnexpiredQueuedMessages(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId)) {
    return [];
  }
  return Message.find({
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    status: ROW_STATUS_ACTIVE,
    role: 'user',
    messageStatus: 'queued',
    expiresAt: { $gt: input.now },
  })
    .sort({ queuedAt: 1, _id: 1 })
    .limit(input.limit)
    .lean()
    .exec();
}

/**
 * Atomically claims a queued message for resume (`queued` → `accepted`).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   messageId: string,
 *   knowledgeVersionId?: string | null,
 *   now: Date,
 * }} input Claim fields.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function claimQueuedMessageForResume(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.messageId)) {
    return null;
  }
  const knowledgeVersionId =
    input.knowledgeVersionId && mongoose.isValidObjectId(input.knowledgeVersionId)
      ? new mongoose.Types.ObjectId(String(input.knowledgeVersionId))
      : null;
  return Message.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.messageId)),
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
      role: 'user',
      messageStatus: 'queued',
      expiresAt: { $gt: input.now },
    },
    {
      $set: {
        messageStatus: 'accepted',
        knowledgeVersionId,
        queuedAt: null,
        expiresAt: null,
        blockingJobId: null,
        queueFailureCode: null,
      },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Creates a pending assistant sibling for an existing user message (queue resume, edit resubmit, retry).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   userMessageId: string,
 *   actorUserId?: string | null,
 *   knowledgeVersionId?: string | null,
 * }} input Assistant insert fields.
 * @returns {Promise<import('mongoose').Document>}
 * @throws {import('../../platform/errors.js').ApiError} When ids are invalid.
 */
export async function insertAssistantForExistingUser(input) {
  assertOrgId(input.orgId);
  if (
    !mongoose.isValidObjectId(input.projectId) ||
    !mongoose.isValidObjectId(input.conversationId) ||
    !mongoose.isValidObjectId(input.userMessageId)
  ) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'userMessageId', message: 'org/project/conversation/user ids must be valid ObjectIds' }],
    });
  }

  const orgId = input.orgId;
  const projectId = new mongoose.Types.ObjectId(String(input.projectId));
  const conversationId = new mongoose.Types.ObjectId(String(input.conversationId));
  const userMessageId = new mongoose.Types.ObjectId(String(input.userMessageId));
  const actorUserId =
    input.actorUserId && mongoose.isValidObjectId(input.actorUserId) ? new mongoose.Types.ObjectId(String(input.actorUserId)) : null;
  const knowledgeVersionId =
    input.knowledgeVersionId && mongoose.isValidObjectId(input.knowledgeVersionId)
      ? new mongoose.Types.ObjectId(String(input.knowledgeVersionId))
      : null;
  const now = new Date();

  const [assistantMessage] = await Message.create([
    {
      orgId,
      projectId,
      conversationId,
      role: 'assistant',
      content: '\u200b',
      messageStatus: 'generating',
      knowledgeVersionId,
      parentMessageId: userMessageId,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    },
  ]);

  await Conversation.updateOne(
    {
      _id: conversationId,
      orgId,
      projectId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $inc: { messageCount: 1 },
      $set: { lastMessageAt: now, ...(actorUserId ? { updatedBy: actorUserId } : {}) },
    },
  ).exec();

  return assistantMessage;
}

/**
 * Marks matching queued messages failed with a catalog queue failure code.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   filter?: Record<string, unknown>,
 *   queueFailureCode?: string,
 * }} input Fail scope.
 * @returns {Promise<number>} Modified count.
 */
export async function markQueuedMessagesFailed(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId)) {
    return 0;
  }
  const result = await Message.updateMany(
    {
      orgId: input.orgId,
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      status: ROW_STATUS_ACTIVE,
      role: 'user',
      messageStatus: 'queued',
      ...(input.filter ?? {}),
    },
    {
      $set: {
        messageStatus: 'failed',
        queueFailureCode: input.queueFailureCode ?? 'KNOWLEDGE_UNAVAILABLE',
        queuedAt: null,
        expiresAt: null,
        blockingJobId: null,
      },
    },
  ).exec();
  return result.modifiedCount ?? 0;
}

/**
 * Fails queued messages whose `expiresAt` has passed (global sweeper).
 * @param {{ now: Date }} input Sweep clock.
 * @returns {Promise<number>} Modified count.
 */
export async function markExpiredQueuedMessagesFailed(input) {
  const result = await Message.updateMany(
    {
      status: ROW_STATUS_ACTIVE,
      role: 'user',
      messageStatus: 'queued',
      expiresAt: { $lte: input.now },
    },
    {
      $set: {
        messageStatus: 'failed',
        queueFailureCode: 'KNOWLEDGE_UNAVAILABLE',
        queuedAt: null,
        expiresAt: null,
        blockingJobId: null,
      },
    },
  ).exec();
  return result.modifiedCount ?? 0;
}

/**
 * Loads one active message in a conversation by id.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 * }} input Scope.
 * @returns {Promise<object | null>}
 */
export async function findActiveMessageInConversation(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId) || !mongoose.isValidObjectId(input.messageId)) {
    return null;
  }
  return Message.findOne({
    _id: new mongoose.Types.ObjectId(String(input.messageId)),
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * True when an active assistant turn is mid-generation (`generating`).
 * User rows stay `accepted` after send, so they must not count as in-flight.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 * }} input Scope.
 * @returns {Promise<boolean>}
 */
export async function conversationHasInFlightChatMessage(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId)) {
    return false;
  }
  const row = await Message.findOne({
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
    status: ROW_STATUS_ACTIVE,
    role: 'assistant',
    messageStatus: 'generating',
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  return Boolean(row);
}

/**
 * Latest active message in the conversation (createdAt, _id descending).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 * }} input Scope.
 * @returns {Promise<object | null>}
 */
export async function findLatestActiveMessageInConversation(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId)) {
    return null;
  }
  return Message.findOne({
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ createdAt: -1, _id: -1 })
    .exec();
}

/**
 * Soft-deletes every active message strictly after a pivot turn (replace-downstream).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   afterCreatedAt: Date,
 *   afterMessageId: string,
 *   actorUserId?: string | null,
 *   session?: import('mongoose').ClientSession,
 * }} input Soft-delete scope.
 * @returns {Promise<{ removedMessageIds: string[], removedAssistantMessageIds: string[], removedCount: number }>}
 */
export async function softDeleteMessagesAfter(input) {
  assertOrgId(input.orgId);
  if (
    !mongoose.isValidObjectId(input.projectId) ||
    !mongoose.isValidObjectId(input.conversationId) ||
    !mongoose.isValidObjectId(input.afterMessageId)
  ) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'messageId', message: 'org/project/conversation/message ids must be valid ObjectIds' }],
    });
  }

  const projectId = new mongoose.Types.ObjectId(String(input.projectId));
  const conversationId = new mongoose.Types.ObjectId(String(input.conversationId));
  const afterMessageId = new mongoose.Types.ObjectId(String(input.afterMessageId));
  const actorUserId =
    input.actorUserId && mongoose.isValidObjectId(input.actorUserId) ? new mongoose.Types.ObjectId(String(input.actorUserId)) : null;
  const afterCreatedAt = input.afterCreatedAt instanceof Date ? input.afterCreatedAt : new Date(input.afterCreatedAt);

  const filter = {
    orgId: input.orgId,
    projectId,
    conversationId,
    status: ROW_STATUS_ACTIVE,
    $or: [{ createdAt: { $gt: afterCreatedAt } }, { createdAt: afterCreatedAt, _id: { $gt: afterMessageId } }],
  };

  let findQuery = Message.find(filter).select({ _id: 1, role: 1 }).lean();
  if (input.session) {
    findQuery = findQuery.session(input.session);
  }
  const rows = await findQuery.exec();
  if (rows.length === 0) {
    return { removedMessageIds: [], removedAssistantMessageIds: [], removedCount: 0 };
  }

  const removedMessageIds = rows.map((row) => String(row._id));
  const removedAssistantMessageIds = rows.filter((row) => row.role === 'assistant').map((row) => String(row._id));
  const now = new Date();

  let updateQuery = Message.updateMany(filter, {
    $set: {
      status: ROW_STATUS_DELETED,
      updatedBy: actorUserId,
      updatedAt: now,
    },
  });
  if (input.session) {
    updateQuery = updateQuery.session(input.session);
  }
  await updateQuery.exec();

  let conversationUpdate = Conversation.updateOne(
    {
      _id: conversationId,
      orgId: input.orgId,
      projectId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $inc: { messageCount: -rows.length },
      ...(actorUserId ? { $set: { updatedBy: actorUserId } } : {}),
    },
  );
  if (input.session) {
    conversationUpdate = conversationUpdate.session(input.session);
  }
  await conversationUpdate.exec();

  return { removedMessageIds, removedAssistantMessageIds, removedCount: rows.length };
}

/**
 * Soft-deletes one active message by id (retry replaces a failed assistant).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   actorUserId?: string | null,
 *   session?: import('mongoose').ClientSession,
 * }} input Soft-delete scope.
 * @returns {Promise<boolean>} True when a row was soft-deleted.
 */
export async function softDeleteActiveMessageById(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId) || !mongoose.isValidObjectId(input.messageId)) {
    return false;
  }

  const projectId = new mongoose.Types.ObjectId(String(input.projectId));
  const conversationId = new mongoose.Types.ObjectId(String(input.conversationId));
  const messageId = new mongoose.Types.ObjectId(String(input.messageId));
  const actorUserId =
    input.actorUserId && mongoose.isValidObjectId(input.actorUserId) ? new mongoose.Types.ObjectId(String(input.actorUserId)) : null;
  const now = new Date();

  let updateQuery = Message.updateOne(
    {
      _id: messageId,
      orgId: input.orgId,
      projectId,
      conversationId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        status: ROW_STATUS_DELETED,
        updatedBy: actorUserId,
        updatedAt: now,
      },
    },
  );
  if (input.session) {
    updateQuery = updateQuery.session(input.session);
  }
  const result = await updateQuery.exec();
  if ((result.modifiedCount ?? 0) === 0) {
    return false;
  }

  let conversationUpdate = Conversation.updateOne(
    {
      _id: conversationId,
      orgId: input.orgId,
      projectId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $inc: { messageCount: -1 },
      ...(actorUserId ? { $set: { updatedBy: actorUserId } } : {}),
    },
  );
  if (input.session) {
    conversationUpdate = conversationUpdate.session(input.session);
  }
  await conversationUpdate.exec();
  return true;
}

/**
 * Updates a user message content in place and bumps edit metadata.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   content: string,
 *   actorUserId: string,
 *   session?: import('mongoose').ClientSession,
 * }} input Edit fields.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function updateUserMessageContentForEdit(input) {
  assertOrgId(input.orgId);
  if (
    !mongoose.isValidObjectId(input.projectId) ||
    !mongoose.isValidObjectId(input.conversationId) ||
    !mongoose.isValidObjectId(input.messageId) ||
    !mongoose.isValidObjectId(input.actorUserId)
  ) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'messageId', message: 'org/project/conversation/message/actor ids must be valid ObjectIds' }],
    });
  }

  const now = new Date();
  let query = Message.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.messageId)),
      orgId: input.orgId,
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
      role: 'user',
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        content: input.content,
        editedAt: now,
        updatedBy: new mongoose.Types.ObjectId(String(input.actorUserId)),
      },
      $inc: { editGeneration: 1 },
    },
    { returnDocument: 'after' },
  );
  if (input.session) {
    query = query.session(input.session);
  }
  return query.exec();
}

/**
 * Marks an existing user message as queued while knowledge is updating (edit/retry 202 path).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   actorUserId: string,
 *   blockingJobId?: string | null,
 *   queuedAt: Date,
 *   expiresAt: Date,
 * }} input Queue fields.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function markUserMessageQueued(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId) || !mongoose.isValidObjectId(input.messageId)) {
    return null;
  }

  const blockingJobId =
    input.blockingJobId && mongoose.isValidObjectId(input.blockingJobId) ? new mongoose.Types.ObjectId(String(input.blockingJobId)) : null;
  const actorUserId =
    input.actorUserId && mongoose.isValidObjectId(input.actorUserId) ? new mongoose.Types.ObjectId(String(input.actorUserId)) : null;

  return Message.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.messageId)),
      orgId: input.orgId,
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
      role: 'user',
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        messageStatus: 'queued',
        queuedAt: input.queuedAt,
        expiresAt: input.expiresAt,
        blockingJobId,
        queueFailureCode: null,
        knowledgeVersionId: null,
        ...(actorUserId ? { updatedBy: actorUserId } : {}),
      },
    },
    { returnDocument: 'after' },
  ).exec();
}
