/**
 * Conversation search query validation and snippet shaping via searchConversations.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_SEARCH_SNIPPET_MAX_CHARS } from '../../../src/modules/conversation/conversation.helper.js';

const searchOwnConversations = vi.hoisted(() => vi.fn());

vi.mock('../../../src/modules/conversation/conversation.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    searchOwnConversations,
  };
});

import { searchConversations } from '../../../src/modules/conversation/conversation.js';

describe('conversations.search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects missing or short queries', async () => {
    await expect(
      searchConversations({
        orgId: 'o1',
        projectId: 'p1',
        userId: 'u1',
        q: undefined,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      searchConversations({
        orgId: 'o1',
        projectId: 'p1',
        userId: 'u1',
        q: 'a',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(searchOwnConversations).not.toHaveBeenCalled();
  });

  it('trims the query, prefers a matching title, and caps the snippet', async () => {
    const longTitle = `${'checkout flow '.repeat(20)}extra`;
    searchOwnConversations.mockResolvedValue({
      items: [
        {
          _id: 'c1',
          title: longTitle,
          searchText: 'payment fails when card declines',
          titleSource: 'user',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    });
    const result = await searchConversations({
      orgId: 'o1',
      projectId: 'p1',
      userId: 'u1',
      q: '  checkout  ',
    });
    expect(searchOwnConversations).toHaveBeenCalledWith(expect.objectContaining({ q: 'checkout' }));
    expect(result.items[0].snippet.startsWith('checkout')).toBe(true);
    expect(result.items[0].snippet.length).toBeLessThanOrEqual(CONVERSATION_SEARCH_SNIPPET_MAX_CHARS);
    expect(result.items[0].snippet.endsWith('...')).toBe(true);
  });

  it('falls back to searchText when the title does not match', async () => {
    searchOwnConversations.mockResolvedValue({
      items: [
        {
          _id: 'c1',
          title: 'Other',
          searchText: 'payment fails when card declines',
          titleSource: 'user',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    });
    const result = await searchConversations({
      orgId: 'o1',
      projectId: 'p1',
      userId: 'u1',
      q: 'payment',
    });
    expect(result.items[0].snippet).toBe('payment fails when card declines');
  });

  it('returns a short title unchanged when under the snippet cap', async () => {
    searchOwnConversations.mockResolvedValue({
      items: [
        {
          _id: 'c1',
          title: 'Hi',
          searchText: '',
          titleSource: 'user',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    });
    const result = await searchConversations({
      orgId: 'o1',
      projectId: 'p1',
      userId: 'u1',
      q: 'hi',
    });
    expect(result.items[0].snippet).toBe('Hi');
  });
});
