/**
 * Conversation DTO constant exports.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_CONVERSATION_LIFECYCLE_STATUSES, KNOWN_MESSAGE_STATUSES } from '@/features/chat/api/conversationTypes.js';

describe('conversationTypes', () => {
  it('exports known lifecycle and message status lists', () => {
    expect(KNOWN_CONVERSATION_LIFECYCLE_STATUSES).toContain('active');
    expect(KNOWN_MESSAGE_STATUSES).toContain('completed');
  });
});
