/**
 * Conversation service race / null-update branches with mocked repository.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadMocks = vi.hoisted(() => ({
  findOwnConversation: vi.fn(),
  archiveOwnConversation: vi.fn(),
  restoreOwnConversation: vi.fn(),
  softDeleteOwnConversation: vi.fn(),
  updateConversationTitleFields: vi.fn(),
  insertConversation: vi.fn(),
  listOwnConversations: vi.fn(),
  listMessagesForConversation: vi.fn(),
  listRecentMessages: vi.fn(),
  searchOwnConversations: vi.fn(),
  recordAuditEvent: vi.fn(),
  adjustProjectConversationCount: vi.fn(),
}));

vi.mock('../../../src/modules/conversation/conversation.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findOwnConversation: loadMocks.findOwnConversation,
    archiveOwnConversation: loadMocks.archiveOwnConversation,
    restoreOwnConversation: loadMocks.restoreOwnConversation,
    softDeleteOwnConversation: loadMocks.softDeleteOwnConversation,
    updateConversationTitleFields: loadMocks.updateConversationTitleFields,
    insertConversation: loadMocks.insertConversation,
    listOwnConversations: loadMocks.listOwnConversations,
    listMessagesForConversation: loadMocks.listMessagesForConversation,
    listRecentMessages: loadMocks.listRecentMessages,
    searchOwnConversations: loadMocks.searchOwnConversations,
  };
});

vi.mock('../../../src/modules/access/index.js', () => ({
  recordAuditEvent: loadMocks.recordAuditEvent,
  buildAuditContextFromRequest: vi.fn(),
}));

vi.mock('../../../src/modules/masters/index.js', () => ({
  adjustProjectConversationCount: loadMocks.adjustProjectConversationCount,
}));

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: vi.fn(async () => ({
        withTransaction: async (fn) => fn(),
        endSession: async () => {},
      })),
    },
  };
});

import {
  archiveConversation,
  createConversation,
  deleteConversation,
  listConversationMessages,
  listConversations,
  restoreConversation,
  searchConversations,
  updateConversationTitle,
} from '../../../src/modules/conversation/conversation.js';

describe('conversations.service edges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadMocks.recordAuditEvent.mockResolvedValue(undefined);
    loadMocks.adjustProjectConversationCount.mockResolvedValue({});
  });

  it('creates, lists, searches, and lists messages through mocked persistence', async () => {
    const row = {
      _id: 'c1',
      projectId: 'p1',
      ownerUserId: 'u1',
      title: 'T',
      titleSource: 'default',
      lifecycleStatus: 'active',
      messageCount: 0,
      lastMessageAt: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    loadMocks.insertConversation.mockResolvedValue(row);
    const created = await createConversation({
      orgId: 'o1',
      projectId: 'p1',
      actorUserId: 'u1',
      correlationId: 'corr',
    });
    expect(created.id).toBe('c1');
    expect(loadMocks.adjustProjectConversationCount).toHaveBeenCalledWith(
      'o1',
      'p1',
      1,
      { session: expect.anything() },
    );

    loadMocks.listOwnConversations.mockResolvedValue({ items: [row], nextCursor: null });
    const listed = await listConversations('o1', 'p1', 'u1', {});
    expect(listed.items).toHaveLength(1);

    loadMocks.findOwnConversation.mockResolvedValue(row);
    loadMocks.listMessagesForConversation.mockResolvedValue({
      items: [
        {
          _id: 'm1',
          role: 'user',
          content: 'hi',
          messageStatus: 'completed',
          createdAt: new Date(),
        },
      ],
      nextCursor: null,
    });
    const messages = await listConversationMessages('o1', 'p1', 'c1', 'u1', {});
    expect(messages.items[0].content).toBe('hi');

    loadMocks.searchOwnConversations.mockResolvedValue({ items: [row], nextCursor: null });
    const searched = await searchConversations({
      orgId: 'o1',
      projectId: 'p1',
      userId: 'u1',
      q: 'ab',
    });
    expect(searched.items[0].id).toBe('c1');
  });

  it('throws when archive, restore, delete, or title update lose the race', async () => {
    const row = {
      _id: 'c1',
      projectId: 'p1',
      ownerUserId: 'u1',
      title: 'T',
      titleSource: 'default',
      lifecycleStatus: 'active',
      messageCount: 0,
    };
    loadMocks.findOwnConversation.mockResolvedValue(row);
    loadMocks.archiveOwnConversation.mockResolvedValue(null);
    await expect(
      archiveConversation({
        orgId: 'o1',
        projectId: 'p1',
        conversationId: 'c1',
        actorUserId: 'u1',
        correlationId: 'corr',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    loadMocks.findOwnConversation.mockResolvedValue({ ...row, lifecycleStatus: 'archived' });
    loadMocks.restoreOwnConversation.mockResolvedValue(null);
    await expect(
      restoreConversation({
        orgId: 'o1',
        projectId: 'p1',
        conversationId: 'c1',
        actorUserId: 'u1',
        correlationId: 'corr',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    loadMocks.findOwnConversation.mockResolvedValue(row);
    loadMocks.softDeleteOwnConversation.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      deleteConversation({
        orgId: 'o1',
        projectId: 'p1',
        conversationId: 'c1',
        actorUserId: 'u1',
        correlationId: 'corr',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });

    loadMocks.updateConversationTitleFields.mockResolvedValue(null);
    await expect(
      updateConversationTitle({
        orgId: 'o1',
        projectId: 'p1',
        conversationId: 'c1',
        actorUserId: 'u1',
        title: 'New title',
        correlationId: 'corr',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
  });
});
