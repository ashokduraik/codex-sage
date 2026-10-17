/**
 * Conversation DTO constant exports.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_CONVERSATION_LIFECYCLE_STATUSES, KNOWN_MESSAGE_STATUSES, KNOWN_SUPPORT_LEVELS } from '@/features/chat/api/conversationTypes.js';

describe('conversationTypes', () => {
  it('exports known lifecycle, message status, and support level lists', () => {
    expect(KNOWN_CONVERSATION_LIFECYCLE_STATUSES).toContain('active');
    expect(KNOWN_MESSAGE_STATUSES).toContain('completed');
    expect(KNOWN_SUPPORT_LEVELS).toContain('evidence_backed');
    expect(KNOWN_SUPPORT_LEVELS).toContain('insufficient');
  });
});
