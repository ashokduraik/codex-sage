/**
 * Conversation lifecycle guard unit tests.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import { assertConversationWritable } from '../../../src/modules/conversation/conversation.js';

const ownerId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();

describe('conversations.lifecycle', () => {
  it('rejects missing or other-owner rows as CONVERSATION_NOT_FOUND', () => {
    expect(() => assertConversationWritable(null, ownerId)).toThrow(ApiError);
    try {
      assertConversationWritable(null, ownerId);
    } catch (err) {
      expect(err.code).toBe('CONVERSATION_NOT_FOUND');
    }
    try {
      assertConversationWritable({ ownerUserId: otherId, lifecycleStatus: 'active' }, ownerId);
    } catch (err) {
      expect(err.code).toBe('CONVERSATION_NOT_FOUND');
    }
  });

  it('rejects writes to archived conversations', () => {
    try {
      assertConversationWritable({ ownerUserId: ownerId, lifecycleStatus: 'archived' }, ownerId);
    } catch (err) {
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('allows writes on an owned active conversation', () => {
    expect(() => assertConversationWritable({ ownerUserId: ownerId, lifecycleStatus: 'active' }, ownerId)).not.toThrow();
  });
});
