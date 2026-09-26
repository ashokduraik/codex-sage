/**
 * Conversation service unit tests for loaders and title validation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import { CONVERSATION_MODELS, Message } from '../../../src/modules/conversation/conversation.js';
import {
  getConversation,
  listRecentMessages,
  loadConversationForUser,
  updateConversationTitle,
} from '../../../src/modules/conversation/conversation.js';
import { insertConversation } from '../../../src/modules/conversation/conversation.helper.js';

const harness = createMongoHarness({
  models: [...PROJECT_MODELS, ...CONVERSATION_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('conversations.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('loads owned conversations and lists recent messages', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const project = await createProjectInRepo(orgId, {
      name: 'Svc',
      sourceType: 'upload',
      createdBy: actor,
    });
    const created = await insertConversation({
      orgId,
      projectId: project._id,
      ownerUserId: actor,
      title: 'Owned',
      titleSource: 'user',
    });
    await Message.create({
      orgId,
      projectId: project._id,
      conversationId: created._id,
      role: 'user',
      content: 'first',
      messageStatus: 'completed',
    });
    await Message.create({
      orgId,
      projectId: project._id,
      conversationId: created._id,
      role: 'assistant',
      content: 'second',
      messageStatus: 'completed',
    });

    const loaded = await loadConversationForUser(String(orgId), String(project._id), String(created._id), String(actor));
    expect(String(loaded._id)).toBe(String(created._id));

    await expect(
      loadConversationForUser(String(orgId), String(project._id), String(created._id), String(new mongoose.Types.ObjectId())),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });

    const header = await getConversation(String(orgId), String(project._id), String(created._id), String(actor));
    expect(header.title).toBe('Owned');

    const recent = await listRecentMessages(String(orgId), String(project._id), String(created._id), 10);
    expect(recent.map((row) => row.content)).toEqual(['first', 'second']);
  });

  it('rejects empty and overlong titles in the service', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const project = await createProjectInRepo(orgId, {
      name: 'Titles',
      sourceType: 'upload',
      createdBy: actor,
    });
    const created = await insertConversation({
      orgId,
      projectId: project._id,
      ownerUserId: actor,
    });
    await expect(
      updateConversationTitle({
        orgId: String(orgId),
        projectId: String(project._id),
        conversationId: String(created._id),
        actorUserId: String(actor),
        title: '   ',
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      updateConversationTitle({
        orgId: String(orgId),
        projectId: String(project._id),
        conversationId: String(created._id),
        actorUserId: String(actor),
        title: 'x'.repeat(201),
        correlationId: 'c2',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
