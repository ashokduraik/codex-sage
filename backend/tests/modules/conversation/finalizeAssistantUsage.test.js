/**
 * finalizeAssistantMessage records question/token projectActivities on completed answers.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { Message } from '../../../src/models/messages.model.js';
import { Conversation } from '../../../src/models/conversations.model.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProjectActivity } from '../../../src/models/projectActivity.model.js';
import { finalizeAssistantMessage } from '../../../src/modules/conversation/conversation.helper.js';

const harness = createMongoHarness({
  models: [Message, Conversation, ProjectActivity],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * Seeds a conversation plus pending assistant message.
 * @returns {Promise<{ orgId: string, projectId: string, conversationId: string, assistantMessageId: string, userId: string }>}
 */
async function seedPendingAssistant() {
  const orgId = new mongoose.Types.ObjectId().toHexString();
  const projectId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const [conversation] = await Conversation.create([
    {
      orgId,
      projectId,
      ownerUserId: userId,
      title: 'Usage test',
      titleSource: 'user',
      lifecycleStatus: 'active',
      createdBy: userId,
      updatedBy: userId,
    },
  ]);
  const [assistant] = await Message.create([
    {
      orgId,
      projectId,
      conversationId: conversation._id,
      role: 'assistant',
      content: ' ',
      messageStatus: 'generating',
      createdBy: userId,
      updatedBy: userId,
    },
  ]);
  return {
    orgId,
    projectId: String(projectId),
    conversationId: String(conversation._id),
    assistantMessageId: String(assistant._id),
    userId: String(userId),
  };
}

describe('finalizeAssistantMessage usage activities', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('records question and token activities for a completed answer with SDK usage', async () => {
    const scope = await seedPendingAssistant();
    await finalizeAssistantMessage({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      assistantMessageId: scope.assistantMessageId,
      content: 'Answer',
      messageStatus: 'completed',
      supportLevel: 'evidence_backed',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      updatedBy: scope.userId,
    });
    const rows = await ProjectActivity.find({ orgId: scope.orgId }).lean();
    expect(rows.map((row) => row.kind).sort()).toEqual(['question.answered', 'tokens.input', 'tokens.output']);
    expect(rows.find((row) => row.kind === 'tokens.input')?.quantity).toBe(10);
    expect(rows.find((row) => row.kind === 'tokens.output')?.quantity).toBe(4);

    await finalizeAssistantMessage({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      assistantMessageId: scope.assistantMessageId,
      content: 'Answer again',
      messageStatus: 'completed',
      supportLevel: 'evidence_backed',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      updatedBy: scope.userId,
    });
    expect(await ProjectActivity.countDocuments({ orgId: scope.orgId })).toBe(3);
  });

  it('records question only when SDK usage is missing', async () => {
    const scope = await seedPendingAssistant();
    await finalizeAssistantMessage({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      assistantMessageId: scope.assistantMessageId,
      content: 'Answer',
      messageStatus: 'completed',
      supportLevel: 'evidence_backed',
      usage: null,
      updatedBy: scope.userId,
    });
    const kinds = (await ProjectActivity.find({ orgId: scope.orgId }).lean()).map((row) => row.kind);
    expect(kinds).toEqual(['question.answered']);
  });

  it('does not record activities for abstained answers', async () => {
    const scope = await seedPendingAssistant();
    await finalizeAssistantMessage({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      assistantMessageId: scope.assistantMessageId,
      content: 'I cannot answer',
      messageStatus: 'abstained',
      supportLevel: 'insufficient',
      usage: { inputTokens: 5, outputTokens: 2 },
      updatedBy: scope.userId,
    });
    expect(await ProjectActivity.countDocuments({ orgId: scope.orgId })).toBe(0);
  });
});
