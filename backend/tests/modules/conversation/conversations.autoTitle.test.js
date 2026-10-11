/**
 * Auto-title stub — truncated user text only when titleSource is default.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { Message } from '../../../src/models/messages.model.js';
import { Conversation } from '../../../src/models/conversations.model.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { insertConversation } from '../../../src/modules/conversation/conversation.helper.js';
import { CONVERSATION_TRUNCATED_TITLE_MAX_CHARS } from '../../../src/modules/conversation/conversation.helper.js';
import { scheduleConversationAutoTitle } from '../../../src/modules/conversation/conversation.js';

const harness = createMongoHarness({
  models: [Conversation, Message],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('conversations.autoTitle', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('collapses whitespace and caps truncated titles when titleSource is default', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const spaced = await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
    });
    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(spaced._id),
      firstUserContent: '  hello   world  ',
    });
    const spacedUpdated = await Conversation.findById(spaced._id);
    expect(spacedUpdated.title).toBe('hello world');
    expect(spacedUpdated.titleSource).toBe('truncated_user_text');

    const longRow = await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
    });
    const long = 'a'.repeat(CONVERSATION_TRUNCATED_TITLE_MAX_CHARS + 10);
    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(longRow._id),
      firstUserContent: long,
    });
    const longUpdated = await Conversation.findById(longRow._id);
    expect(longUpdated.title.length).toBe(CONVERSATION_TRUNCATED_TITLE_MAX_CHARS);
  });

  it('sets a truncated title only when titleSource is still default', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const created = await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
    });
    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(created._id),
      firstUserContent: 'How does checkout work on decline?',
    });
    const updated = await Conversation.findById(created._id);
    expect(updated.titleSource).toBe('truncated_user_text');
    expect(updated.title).toContain('How does checkout');

    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(created._id),
      firstUserContent: 'A different question that should not win',
    });
    const again = await Conversation.findById(created._id);
    expect(again.title).toBe(updated.title);
  });

  it('does not change a user-set title and no-ops on empty or missing rows', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const named = await insertConversation({
      orgId,
      projectId,
      ownerUserId: owner,
      title: 'Payment failure investigation',
      titleSource: 'user',
    });
    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(named._id),
      firstUserContent: 'should not apply',
    });
    const reloaded = await Conversation.findById(named._id);
    expect(reloaded.title).toBe('Payment failure investigation');
    expect(reloaded.titleSource).toBe('user');

    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(named._id),
    });
    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(named._id),
      firstUserContent: '   ',
    });
    await scheduleConversationAutoTitle({
      orgId,
      projectId: String(projectId),
      conversationId: String(new mongoose.Types.ObjectId()),
      firstUserContent: 'gone',
    });
  });
});
