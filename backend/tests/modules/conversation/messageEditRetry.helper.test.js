/**
 * Unit tests for Phase 53 message edit/retry persistence helpers.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { Message } from '../../../src/models/messages.model.js';
import { Conversation } from '../../../src/models/conversations.model.js';
import { ClarificationSet } from '../../../src/models/clarificationSet.model.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../../src/platform/data/index.js';
import { supersedeOpenClarificationSetsForMessages } from '../../../src/modules/conversation/clarification.js';
import {
  softDeleteMessagesAfter,
  softDeleteActiveMessageById,
  insertAssistantForExistingUser,
  updateUserMessageContentForEdit,
  conversationHasInFlightChatMessage,
  findLatestActiveMessageInConversation,
} from '../../../src/modules/conversation/conversation.helper.js';

const harness = createMongoHarness({
  models: [Conversation, Message, ClarificationSet],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('message edit/retry helpers', () => {
  /** @type {string} */
  let orgId;
  /** @type {mongoose.Types.ObjectId} */
  let projectId;
  /** @type {mongoose.Types.ObjectId} */
  let conversationId;
  /** @type {mongoose.Types.ObjectId} */
  let actorUserId;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  beforeEach(async () => {
    orgId = new mongoose.Types.ObjectId().toString();
    projectId = new mongoose.Types.ObjectId();
    conversationId = new mongoose.Types.ObjectId();
    actorUserId = new mongoose.Types.ObjectId();
    await Conversation.create({
      _id: conversationId,
      orgId,
      projectId,
      ownerUserId: actorUserId,
      title: 'Edit helpers',
      titleSource: 'default',
      lifecycleStatus: 'active',
      messageCount: 0,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('soft-deletes only messages strictly after the pivot and decrements messageCount', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T00:00:01.000Z');
    const t2 = new Date('2026-01-01T00:00:02.000Z');
    const u1 = await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'user',
      content: 'U1',
      messageStatus: 'accepted',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    const a1 = await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'assistant',
      content: 'A1',
      messageStatus: 'completed',
      parentMessageId: u1._id,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    const u2 = await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'user',
      content: 'U2',
      messageStatus: 'accepted',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    await Message.collection.updateOne({ _id: u1._id }, { $set: { createdAt: t0, updatedAt: t0 } });
    await Message.collection.updateOne({ _id: a1._id }, { $set: { createdAt: t1, updatedAt: t1 } });
    await Message.collection.updateOne({ _id: u2._id }, { $set: { createdAt: t2, updatedAt: t2 } });
    await Conversation.updateOne({ _id: conversationId }, { $set: { messageCount: 3 } });

    const result = await softDeleteMessagesAfter({
      orgId,
      projectId: String(projectId),
      conversationId: String(conversationId),
      afterCreatedAt: t0,
      afterMessageId: String(u1._id),
      actorUserId: String(actorUserId),
    });

    expect(result.removedCount).toBe(2);
    expect(result.removedMessageIds.sort()).toEqual([String(a1._id), String(u2._id)].sort());
    expect(result.removedAssistantMessageIds).toEqual([String(a1._id)]);

    const active = await Message.find({ conversationId, status: ROW_STATUS_ACTIVE }).lean();
    expect(active).toHaveLength(1);
    expect(String(active[0]._id)).toBe(String(u1._id));

    const conversation = await Conversation.findById(conversationId).lean();
    expect(conversation?.messageCount).toBe(1);
  });

  it('increments editGeneration and sets editedAt on user content update', async () => {
    const user = await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'user',
      content: 'old',
      messageStatus: 'accepted',
      editGeneration: 0,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    const updated = await updateUserMessageContentForEdit({
      orgId,
      projectId: String(projectId),
      conversationId: String(conversationId),
      messageId: String(user._id),
      content: 'new question',
      actorUserId: String(actorUserId),
    });

    expect(updated?.content).toBe('new question');
    expect(updated?.editGeneration).toBe(1);
    expect(updated?.editedAt).toBeInstanceOf(Date);
  });

  it('does not treat accepted user messages as in-flight', async () => {
    await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'user',
      content: 'U1',
      messageStatus: 'accepted',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    expect(
      await conversationHasInFlightChatMessage({
        orgId,
        projectId: String(projectId),
        conversationId: String(conversationId),
      }),
    ).toBe(false);

    await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'assistant',
      content: '\u200b',
      messageStatus: 'generating',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    expect(
      await conversationHasInFlightChatMessage({
        orgId,
        projectId: String(projectId),
        conversationId: String(conversationId),
      }),
    ).toBe(true);
  });

  it('inserts an assistant linked to an existing user and finds latest active', async () => {
    const user = await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'user',
      content: 'question',
      messageStatus: 'accepted',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    await Conversation.updateOne({ _id: conversationId }, { $set: { messageCount: 1 } });

    const assistant = await insertAssistantForExistingUser({
      orgId,
      projectId: String(projectId),
      conversationId: String(conversationId),
      userMessageId: String(user._id),
      actorUserId: String(actorUserId),
    });
    expect(String(assistant.parentMessageId)).toBe(String(user._id));
    expect(assistant.messageStatus).toBe('generating');

    const latest = await findLatestActiveMessageInConversation({
      orgId,
      projectId: String(projectId),
      conversationId: String(conversationId),
    });
    expect(String(latest?._id)).toBe(String(assistant._id));

    const deleted = await softDeleteActiveMessageById({
      orgId,
      projectId: String(projectId),
      conversationId: String(conversationId),
      messageId: String(assistant._id),
      actorUserId: String(actorUserId),
    });
    expect(deleted).toBe(true);
    const row = await Message.findOne({ _id: assistant._id, status: ROW_STATUS_DELETED }).lean();
    expect(row?.status).toBe(ROW_STATUS_DELETED);
  });

  it('supersedes open clarification sets for soft-deleted assistants', async () => {
    const assistantId = new mongoose.Types.ObjectId();
    await ClarificationSet.create({
      orgId,
      projectId,
      conversationId,
      messageId: assistantId,
      clarificationSetId: `clr_${assistantId.toString()}`,
      roundIndex: 0,
      setStatus: 'open',
      questions: [{ id: 'q1', type: 'free_text', prompt: 'Which module?', required: true }],
      answers: null,
      issuedAt: new Date(),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    await supersedeOpenClarificationSetsForMessages({
      orgId,
      messageIds: [String(assistantId)],
      actorUserId: String(actorUserId),
    });

    const set = await ClarificationSet.findOne({ messageId: assistantId, status: ROW_STATUS_DELETED }).lean();
    expect(set?.setStatus).toBe('superseded');
    expect(set?.status).toBe(ROW_STATUS_DELETED);
  });
});
