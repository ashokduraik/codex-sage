/**
 * Conversation React Query key shape.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsListQueryKey,
  conversationDetailQueryKey,
  conversationsSearchQueryKey,
  conversationMessagesQueryKey,
} from '@/features/chat/conversationQueryKeys.js';

describe('conversationQueryKeys', () => {
  it('includes projectId and archived flag on list keys', () => {
    expect(conversationsListQueryKey('p1', { archived: true })).toEqual(['conversations', 'list', 'p1', { archived: true, limit: null }]);
    expect(conversationsListQueryKey('p1', { archived: false, limit: 10 })).toEqual(['conversations', 'list', 'p1', { archived: false, limit: 10 }]);
  });

  it('includes project and conversation ids on detail and messages keys', () => {
    expect(conversationDetailQueryKey('p1', 'c1')).toEqual(['conversations', 'detail', 'p1', 'c1']);
    expect(conversationMessagesQueryKey('p1', 'c1')).toEqual(['conversations', 'messages', 'p1', 'c1', { limit: null }]);
  });

  it('includes q and archived on search keys', () => {
    expect(conversationsSearchQueryKey('p1', { q: 'auth', archived: false })).toEqual([
      'conversations',
      'search',
      'p1',
      { q: 'auth', archived: false, limit: null },
    ]);
  });
});
