/**
 * Conversation repository scoping, pagination, and searchText writer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { encodeCursor, ROW_STATUS_ACTIVE } from '../../../src/platform/data/index.js';
import { CONVERSATION_DEFAULT_TITLE } from '../../../src/modules/conversation/conversation.helper.js';
import { Conversation } from '../../../src/models/conversations.model.js';
import { Message } from '../../../src/models/messages.model.js';
import {
  clampConversationSearchLimit,
  clampConversationsListLimit,
  clampMessagesListLimit,
  archiveOwnConversation,
  findConversationInProject,
  findOwnConversation,
  insertConversation,
  restoreOwnConversation,
  softDeleteOwnConversation,
  updateConversationTitleFields,
  listMessagesForConversation,
  listOwnConversations,
  listRecentMessages,
  buildOwnConversationFilter,
  refreshConversationSearchText,
  searchOwnConversations,
} from '../../../src/modules/conversation/conversation.helper.js';
import {
  CONVERSATION_SEARCH_DEFAULT_LIMIT,
  CONVERSATION_SEARCH_MAX_LIMIT,
  CONVERSATION_SEARCH_TEXT_MAX_CHARS,
  CONVERSATIONS_LIST_DEFAULT_LIMIT,
  CONVERSATIONS_LIST_MAX_LIMIT,
  MESSAGES_LIST_DEFAULT_LIMIT,
  MESSAGES_LIST_MAX_LIMIT,
} from '../../../src/modules/conversation/conversation.helper.js';

const harness = createMongoHarness({
  models: [Conversation, Message],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('conversations.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('clamps list and search limits', () => {
    expect(clampConversationsListLimit(undefined)).toBe(CONVERSATIONS_LIST_DEFAULT_LIMIT);
    expect(clampConversationsListLimit(0)).toBe(CONVERSATIONS_LIST_DEFAULT_LIMIT);
    expect(clampConversationsListLimit(999)).toBe(CONVERSATIONS_LIST_MAX_LIMIT);
    expect(clampMessagesListLimit(3)).toBe(3);
    expect(clampMessagesListLimit(9999)).toBe(MESSAGES_LIST_MAX_LIMIT);
    expect(clampMessagesListLimit(null)).toBe(MESSAGES_LIST_DEFAULT_LIMIT);
    expect(clampConversationSearchLimit('')).toBe(CONVERSATION_SEARCH_DEFAULT_LIMIT);
    expect(clampConversationSearchLimit(500)).toBe(CONVERSATION_SEARCH_MAX_LIMIT);
  });

  it('inserts with the default title and hides other owners', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const created = await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
    });
    expect(created.title).toBe(CONVERSATION_DEFAULT_TITLE);
    expect(created.titleSource).toBe('default');
    expect(
      await findOwnConversation(orgId, String(projectId), String(created._id), other),
    ).toBeNull();
    expect(
      await findOwnConversation(orgId, String(projectId), String(created._id), owner),
    ).not.toBeNull();
    expect(await findConversationInProject(orgId, String(projectId), String(created._id))).not.toBeNull();
    expect(await findOwnConversation(orgId, 'bad', String(created._id), owner)).toBeNull();
    expect(await findConversationInProject(orgId, String(projectId), 'bad')).toBeNull();
  });

  it('lists only active owned rows and paginates; rejects a bad cursor', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const first = await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
      title: 'One',
      titleSource: 'user',
    });
    await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
      title: 'Two',
      titleSource: 'user',
    });
    const page1 = await listOwnConversations(orgId, String(projectId), owner, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listOwnConversations(orgId, String(projectId), owner, {
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(String(page2.items[0]._id)).not.toBe(String(page1.items[0]._id));

    await expect(
      listOwnConversations(orgId, String(projectId), owner, { cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    const archivedPage = await listOwnConversations(orgId, String(projectId), owner, {
      archived: true,
    });
    expect(archivedPage.items).toHaveLength(0);

    const empty = await listOwnConversations(orgId, 'bad', owner, {});
    expect(empty.items).toEqual([]);
    expect(first.title).toBe('One');
  });

  it('lists messages oldest-first across pages and returns recent messages reversed', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const conversationId = new mongoose.Types.ObjectId();
    const stamps = [
      new Date('2026-09-12T10:00:00.000Z'),
      new Date('2026-09-12T10:01:00.000Z'),
      new Date('2026-09-12T10:02:00.000Z'),
    ];
    for (let index = 0; index < stamps.length; index += 1) {
      const row = new Message({
        orgId,
        projectId,
        conversationId,
        role: 'user',
        content: `m${index}`,
        messageStatus: 'completed',
        createdBy: null,
      });
      await row.save();
      await Message.updateOne({ _id: row._id }, { $set: { createdAt: stamps[index] } });
    }

    const page1 = await listMessagesForConversation(
      orgId,
      String(projectId),
      String(conversationId),
      { limit: 2 },
    );
    expect(page1.items.map((row) => row.content)).toEqual(['m0', 'm1']);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listMessagesForConversation(
      orgId,
      String(projectId),
      String(conversationId),
      { limit: 2, cursor: page1.nextCursor },
    );
    expect(page2.items.map((row) => row.content)).toEqual(['m2']);

    const recent = await listRecentMessages(
      orgId,
      String(projectId),
      String(conversationId),
      2,
    );
    expect(recent.map((row) => row.content)).toEqual(['m1', 'm2']);
    expect(await listRecentMessages(orgId, 'bad', String(conversationId), 2)).toEqual([]);
    expect(
      await listMessagesForConversation(orgId, 'bad', String(conversationId), {}),
    ).toEqual({ items: [], nextCursor: null });

    await expect(
      listMessagesForConversation(orgId, String(projectId), String(conversationId), {
        cursor: encodeCursor({ t: 'not-a-date', i: String(conversationId) }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('rebuilds searchText from messages and caps length', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const created = await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
      title: 'Checkout flow',
      titleSource: 'user',
    });
    await Message.create({
      orgId,
      projectId,
      conversationId: created._id,
      role: 'user',
      content: 'payment fails when card declines',
      messageStatus: 'completed',
    });
    const text = await refreshConversationSearchText({
      orgId,
      projectId: String(projectId),
      conversationId: String(created._id),
    });
    expect(text).toContain('payment fails');
    const reloaded = await Conversation.findById(created._id);
    expect(reloaded.searchText).toBe(text);

    await Message.create({
      orgId,
      projectId,
      conversationId: created._id,
      role: 'assistant',
      content: 'x'.repeat(CONVERSATION_SEARCH_TEXT_MAX_CHARS),
      messageStatus: 'completed',
    });
    const capped = await refreshConversationSearchText({
      orgId,
      projectId: String(projectId),
      conversationId: String(created._id),
    });
    expect(capped.length).toBe(CONVERSATION_SEARCH_TEXT_MAX_CHARS);

    await Message.create({
      orgId,
      projectId,
      conversationId: created._id,
      role: 'user',
      content: 'overflow after cap',
      messageStatus: 'completed',
    });
    const overflowed = await refreshConversationSearchText({
      orgId,
      projectId: String(projectId),
      conversationId: String(created._id),
    });
    expect(overflowed.length).toBe(CONVERSATION_SEARCH_TEXT_MAX_CHARS);

    expect(
      await refreshConversationSearchText({
        orgId,
        projectId: 'bad',
        conversationId: String(created._id),
      }),
    ).toBe('');
  });

  it('searches owned title text and ignores other owners', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
      title: 'UniqueCheckoutNeedle',
      titleSource: 'user',
    });
    await insertConversation({
      orgId,
      projectId,
      ownerUserId: other,
      title: 'UniqueCheckoutNeedle',
      titleSource: 'user',
    });
    const hits = await searchOwnConversations({
      orgId,
      projectId: String(projectId),
      userId: owner,
      q: 'UniqueCheckoutNeedle',
    });
    expect(hits.items).toHaveLength(1);
    expect(String(hits.items[0].ownerUserId)).toBe(String(owner));

    const none = await searchOwnConversations({
      orgId,
      projectId: 'bad',
      userId: owner,
      q: 'UniqueCheckoutNeedle',
    });
    expect(none.items).toEqual([]);

    await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
      title: 'UniqueCheckoutNeedle two',
      titleSource: 'user',
    });
    const page1 = await searchOwnConversations({
      orgId,
      projectId: String(projectId),
      userId: owner,
      q: 'UniqueCheckoutNeedle',
      limit: 1,
    });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await searchOwnConversations({
      orgId,
      projectId: String(projectId),
      userId: owner,
      q: 'UniqueCheckoutNeedle',
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(String(page2.items[0]._id)).not.toBe(String(page1.items[0]._id));
  });

  it('returns null for lifecycle writes with invalid ids', async () => {
    const orgId = new mongoose.Types.ObjectId();
    expect(
      await archiveOwnConversation({
        orgId,
        projectId: 'bad',
        conversationId: 'bad',
        userId: orgId,
      }),
    ).toBeNull();
    expect(
      await restoreOwnConversation({
        orgId,
        projectId: 'bad',
        conversationId: 'bad',
        userId: orgId,
      }),
    ).toBeNull();
    const deleted = await softDeleteOwnConversation({
      orgId,
      projectId: 'bad',
      conversationId: 'bad',
      userId: orgId,
    });
    expect(deleted.modifiedCount).toBe(0);
    expect(
      await updateConversationTitleFields({
        orgId,
        projectId: 'bad',
        conversationId: 'bad',
        title: 'X',
        titleSource: 'user',
      }),
    ).toBeNull();
  });
});

describe('buildOwnConversationFilter', () => {
  it('always scopes to org, project, owner, and active status', () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const filter = buildOwnConversationFilter(orgId, String(projectId), String(userId));
    expect(filter.orgId).toEqual(orgId);
    expect(String(filter.projectId)).toBe(String(projectId));
    expect(String(filter.ownerUserId)).toBe(String(userId));
    expect(filter.status).toBe(ROW_STATUS_ACTIVE);
  });
});
