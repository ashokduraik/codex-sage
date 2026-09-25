/**
 * Conversation search query and snippet unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_SEARCH_SNIPPET_MAX_CHARS,
} from './conversations.constants.js';
import {
  buildConversationSnippet,
  parseConversationSearchQuery,
} from './conversations.service.js';

describe('conversations.search', () => {
  it('rejects missing or short queries', () => {
    try {
      parseConversationSearchQuery(undefined);
      throw new Error('expected VALIDATION_ERROR');
    } catch (err) {
      expect(err.code).toBe('VALIDATION_ERROR');
    }
    try {
      parseConversationSearchQuery('a');
    } catch (err) {
      expect(err.code).toBe('VALIDATION_ERROR');
    }
    expect(parseConversationSearchQuery('  ab  ')).toBe('ab');
  });

  it('prefers the title when it contains the query and caps length', () => {
    const longTitle = `${'checkout flow '.repeat(20)}extra`;
    const snippet = buildConversationSnippet(
      { title: longTitle, searchText: 'payment fails when card declines' },
      'checkout',
    );
    expect(snippet.startsWith('checkout')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(CONVERSATION_SEARCH_SNIPPET_MAX_CHARS);
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('falls back to searchText when the title does not match', () => {
    const snippet = buildConversationSnippet(
      { title: 'Other', searchText: 'payment fails when card declines' },
      'payment',
    );
    expect(snippet).toBe('payment fails when card declines');
  });

  it('returns the source unchanged when under the cap and handles tiny caps', () => {
    expect(buildConversationSnippet({ title: 'Hi' }, 'hi')).toBe('Hi');
    expect(buildConversationSnippet({ title: 'abcdef' }, 'ab', 2)).toBe('ab');
    expect(buildConversationSnippet({ title: '' }, 'nope')).toBe('');
  });
});
