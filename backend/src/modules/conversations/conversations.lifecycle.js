/**
 * Conversation archive / restore guards — no I/O.
 */
import { ApiError } from '../../platform/errors.js';

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
