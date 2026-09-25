/**
 * Auto-title stub — truncated user text only when titleSource is default.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import {
  CONVERSATION_TRUNCATED_TITLE_MAX_CHARS,
} from './conversations.constants.js';
import {
  scheduleConversationAutoTitle,
  truncateUserTextTitle,
} from './conversations.service.js';
import { Conversation } from './conversations.model.js';
import { Message } from './messages.model.js';
import { insertConversation } from './conversations.repository.js';

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

  it('collapses whitespace and caps truncated titles', () => {
    expect(truncateUserTextTitle('  hello   world  ', 20)).toBe('hello world');
    expect(truncateUserTextTitle('   ', 10)).toBe('');
    const long = 'a'.repeat(CONVERSATION_TRUNCATED_TITLE_MAX_CHARS + 10);
    expect(truncateUserTextTitle(long, CONVERSATION_TRUNCATED_TITLE_MAX_CHARS).length).toBe(
      CONVERSATION_TRUNCATED_TITLE_MAX_CHARS,
    );
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
