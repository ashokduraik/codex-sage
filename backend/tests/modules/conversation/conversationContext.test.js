/**
 * Conversation context — extractive summary, pins, measured metrics, GET /context.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { nextTestUserCode } from '../../identityFixtures.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { KNOWLEDGE_MODELS } from '../../../src/modules/knowledge/index.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { KnowledgeVersion } from '../../../src/models/knowledgeVersion.model.js';
import { addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import { getConversationContextView } from '../../../src/modules/conversation/conversationContext.js';
import { archiveOwnConversation, insertConversation } from '../../../src/modules/conversation/conversation.helper.js';
import {
  findRoleByCode,
  IDENTITY_MODELS,
  createRoleInRepo,
  createUserInRepo,
  runBootstrapSeed,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  findOrganizationBySlug,
} from '../../../src/modules/masters/index.js';
import {
  Message,
  pinFact,
  unpinFact,
  CONVERSATION_MODELS,
  PINNED_FACTS_MAX_COUNT,
  SUMMARY_TEXT_MAX_CHARS,
  buildConversationContext,
  updateConversationSummary,
  applySummaryFromCompaction,
  persistMessageContextMetrics,
} from '../../../src/modules/conversation/index.js';

const serviceHarness = createMongoHarness({
  models: [...PROJECT_MODELS, ...CONVERSATION_MODELS, ...KNOWLEDGE_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

const routeHarness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS, ...IDEMPOTENCY_MODELS, ...PROJECT_MODELS, ...CONVERSATION_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

/**
 * Creates a project, owned conversation, and optional messages for service tests.
 * @param {{ title?: string, messages?: { role: string, content: string }[] }} [options] Fixture options.
 */
async function createOwnedThread(options = {}) {
  const orgId = new mongoose.Types.ObjectId();
  const actor = new mongoose.Types.ObjectId();
  const project = await createProjectInRepo(orgId, {
    name: 'Context',
    sourceType: 'upload',
    createdBy: actor,
  });
  const conversation = await insertConversation({
    orgId,
    projectId: project._id,
    ownerUserId: actor,
    title: options.title ?? 'Context thread',
    titleSource: 'user',
  });
  /** @type {import('mongoose').Document[]} */
  const messages = [];
  for (const row of options.messages ?? []) {
    messages.push(
      await Message.create({
        orgId,
        projectId: project._id,
        conversationId: conversation._id,
        role: row.role,
        content: row.content,
        messageStatus: 'completed',
      }),
    );
  }
  return {
    orgId: String(orgId),
    actorUserId: String(actor),
    projectId: String(project._id),
    conversationId: String(conversation._id),
    conversation,
    messages,
  };
}

describe('conversationContext services', () => {
  beforeAll(async () => {
    await serviceHarness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await serviceHarness.afterEach();
  });

  afterAll(async () => {
    await serviceHarness.afterAll();
  });

  it('builds segments with summary, protected pins, and recent turns in order', async () => {
    const thread = await createOwnedThread({
      messages: [
        { role: 'user', content: 'How does login work?' },
        { role: 'assistant', content: 'It uses sessions.' },
        { role: 'user', content: 'And cookies?' },
      ],
    });
    await pinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      id: 'pin-cookies',
      text: 'Auth uses cookies',
      source: 'clarification',
      messageId: String(thread.messages[0]._id),
    });
    await updateConversationSummary(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      throughMessageId: String(thread.messages[0]._id),
    });

    const loaded = await buildConversationContext(thread.orgId, thread.projectId, thread.conversationId, {
      actorUserId: thread.actorUserId,
    });
    expect(loaded.summarySegment).toEqual({
      id: 'summary',
      kind: 'summary',
      content: 'How does login work?',
    });
    expect(loaded.pinnedSegments).toEqual([{ id: 'pin:pin-cookies', kind: 'pinned_fact', content: 'Auth uses cookies', protected: true }]);
    expect(loaded.segments[0].kind).toBe('summary');
    expect(loaded.segments[1].protected).toBe(true);
    expect(loaded.segments.slice(2).map((segment) => segment.kind)).toEqual(['turn', 'turn', 'turn']);
    expect(loaded.recentMessageIds).toHaveLength(3);
  });

  it('limits recent turns with budgetHint and writes a deterministic truncated summary', async () => {
    const longQuestion = `${'q'.repeat(SUMMARY_TEXT_MAX_CHARS)}EXTRA`;
    const thread = await createOwnedThread({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: longQuestion },
      ],
    });
    const limited = await buildConversationContext(thread.orgId, thread.projectId, thread.conversationId, {
      actorUserId: thread.actorUserId,
      budgetHint: 1,
    });
    expect(limited.recentMessageIds).toHaveLength(1);
    expect(limited.segments.filter((segment) => segment.kind === 'turn')).toHaveLength(1);

    await updateConversationSummary(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      throughMessageId: String(thread.messages[2]._id),
    });
    const again = await updateConversationSummary(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      throughMessageId: String(thread.messages[2]._id),
    });
    expect(again).toBeUndefined();
    const loaded = await buildConversationContext(thread.orgId, thread.projectId, thread.conversationId, {
      actorUserId: thread.actorUserId,
    });
    expect(loaded.summarySegment.content).toHaveLength(SUMMARY_TEXT_MAX_CHARS);
    expect(loaded.summarySegment.content.endsWith('EXTRA')).toBe(false);
    expect(loaded.summarySegment.content.startsWith('one\n')).toBe(true);
  });

  it('refreshes summaryCoversThroughMessageId only on replace_with_summary', async () => {
    const thread = await createOwnedThread({
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'Answer' },
      ],
    });
    await applySummaryFromCompaction(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      throughMessageId: String(thread.messages[0]._id),
      compactionActions: [{ action: 'drop_turn', segmentId: 't1' }],
    });
    let loaded = await buildConversationContext(thread.orgId, thread.projectId, thread.conversationId, {
      actorUserId: thread.actorUserId,
    });
    expect(loaded.summarySegment).toBeUndefined();

    await applySummaryFromCompaction(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      throughMessageId: String(thread.messages[0]._id),
      compactionActions: [{ action: 'replace_with_summary', segmentId: 't1' }],
    });
    const conversation = await mongoose.model('Conversation').findById(thread.conversationId);
    expect(String(conversation.context.summaryCoversThroughMessageId)).toBe(String(thread.messages[0]._id));
    loaded = await buildConversationContext(thread.orgId, thread.projectId, thread.conversationId, {
      actorUserId: thread.actorUserId,
    });
    expect(loaded.summarySegment.content).toBe('First question');
  });

  it('persists metrics only when accounting succeeded and omits percent without a budget', async () => {
    const thread = await createOwnedThread({
      messages: [{ role: 'assistant', content: 'Done' }],
    });
    const assistantId = String(thread.messages[0]._id);
    await persistMessageContextMetrics(assistantId, { measuredInputTokens: 10 });
    let row = await Message.findById(assistantId);
    expect(row.contextMetrics).toBeNull();

    await persistMessageContextMetrics(assistantId, {
      measuredInputTokens: 5,
      validatedContextCapacity: 131072,
    });
    row = await Message.findById(assistantId);
    expect(row.contextMetrics.maximumInputBudget).toBeUndefined();
    expect(row.contextMetrics.reservedOutputTokens).toBeUndefined();
    expect(row.contextMetrics.compactionActions).toBeUndefined();

    await persistMessageContextMetrics(assistantId, {
      measuredInputTokens: 82,
      validatedContextCapacity: 131072,
      maximumInputBudget: 0,
      reservedOutputTokens: 457,
      compactionActions: [],
    });
    row = await Message.findById(assistantId);
    expect(row.contextMetrics.contextPercentUsed).toBeUndefined();
    expect(row.contextMetrics.maximumInputBudget).toBe(0);
    expect(row.contextMetrics.measuredInputTokens).toBe(82);
    expect(row.contextMetrics.validatedContextCapacity).toBe(131072);

    await persistMessageContextMetrics(assistantId, {
      measuredInputTokens: 82,
      validatedContextCapacity: 131072,
      maximumInputBudget: 100,
      reservedOutputTokens: 457,
      compactionActions: [{ action: 'replace_with_summary', segmentId: 't1', beforeTokens: 400, afterTokens: 120 }],
    });
    row = await Message.findById(assistantId);
    expect(row.contextMetrics.contextPercentUsed).toBe(0.82);
    expect(row.contextMetrics.maximumInputBudget).toBe(100);
  });

  it('enforces pin max and rejects a duplicate pin id', async () => {
    const thread = await createOwnedThread();
    for (let index = 0; index < PINNED_FACTS_MAX_COUNT; index += 1) {
      await pinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
        id: `pin-${index}`,
        text: `fact ${index}`,
        source: 'user_correction',
      });
    }
    await expect(
      pinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
        id: 'pin-overflow',
        text: 'too many',
        source: 'clarification',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const smaller = await createOwnedThread();
    await pinFact(smaller.orgId, smaller.projectId, smaller.conversationId, smaller.actorUserId, {
      id: 'same',
      text: 'once',
      source: 'clarification',
    });
    await expect(
      pinFact(smaller.orgId, smaller.projectId, smaller.conversationId, smaller.actorUserId, {
        id: 'same',
        text: 'twice',
        source: 'clarification',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await unpinFact(smaller.orgId, smaller.projectId, smaller.conversationId, smaller.actorUserId, 'same');
    const afterUnpin = await buildConversationContext(smaller.orgId, smaller.projectId, smaller.conversationId, {
      actorUserId: smaller.actorUserId,
    });
    expect(afterUnpin.pinnedSegments).toEqual([]);
  });

  it('does not write knowledge collections when summary or pins change', async () => {
    const before = await KnowledgeVersion.countDocuments();
    const thread = await createOwnedThread({
      messages: [{ role: 'user', content: 'Keep knowledge untouched' }],
    });
    await pinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      id: 'pin-k',
      text: 'stay local',
      source: 'clarification',
    });
    await updateConversationSummary(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      throughMessageId: String(thread.messages[0]._id),
    });
    expect(await KnowledgeVersion.countDocuments()).toBe(before);
    const view = await getConversationContextView(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId);
    expect(view.summaryPresent).toBe(true);
    expect(view.summaryUpdatedAt).toBeTruthy();
    expect(view.pinnedFactCount).toBe(1);
    expect(view.lastRunMetrics).toBeUndefined();
  });

  it('skips pin rows without an id and omits empty lastRunMetrics', async () => {
    const thread = await createOwnedThread({
      messages: [{ role: 'assistant', content: 'metrics later' }],
    });
    await mongoose
      .model('Conversation')
      .updateOne(
        { _id: thread.conversationId },
        { $set: { 'context.pinnedFacts': [{ id: '', text: 'ignored', source: 'clarification', createdAt: new Date() }] } },
      );
    const loaded = await buildConversationContext(thread.orgId, thread.projectId, thread.conversationId, {
      actorUserId: thread.actorUserId,
    });
    expect(loaded.pinnedSegments).toEqual([]);

    await Message.updateOne({ _id: thread.messages[0]._id }, { $set: { contextMetrics: { note: 'not measured' } } });
    const view = await getConversationContextView(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId);
    expect(view.lastRunMetrics).toBeUndefined();
  });

  it('rejects pins on an archived conversation', async () => {
    const thread = await createOwnedThread();
    await archiveOwnConversation({
      orgId: thread.orgId,
      projectId: thread.projectId,
      conversationId: thread.conversationId,
      userId: thread.actorUserId,
    });
    await expect(
      pinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
        id: 'pin-archived',
        text: 'nope',
        source: 'clarification',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('returns 404-equivalent errors for missing owner, bad ids, and user-row metrics', async () => {
    const thread = await createOwnedThread({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    });
    await expect(
      buildConversationContext(thread.orgId, thread.projectId, thread.conversationId, {
        actorUserId: String(new mongoose.Types.ObjectId()),
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(
      updateConversationSummary(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
        throughMessageId: 'not-an-id',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      updateConversationSummary(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
        throughMessageId: String(new mongoose.Types.ObjectId()),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      persistMessageContextMetrics('bad', {
        measuredInputTokens: 1,
        validatedContextCapacity: 10,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      persistMessageContextMetrics(String(thread.messages[0]._id), {
        measuredInputTokens: 1,
        validatedContextCapacity: 10,
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(
      pinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
        id: '',
        text: '',
        source: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(unpinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, 'missing')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(unpinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, '   ')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      pinFact(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
        id: 'pin-bad-msg',
        text: 'bad message',
        source: 'clarification',
        messageId: 'not-valid',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      persistMessageContextMetrics(String(new mongoose.Types.ObjectId()), {
        measuredInputTokens: 1,
        validatedContextCapacity: 10,
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await applySummaryFromCompaction(thread.orgId, thread.projectId, thread.conversationId, thread.actorUserId, {
      throughMessageId: String(thread.messages[0]._id),
    });
  });
});

describe('conversationContext HTTP', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await routeHarness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await routeHarness.afterEach();
  });

  afterAll(async () => {
    await routeHarness.afterAll();
  });

  /**
   * @returns {Promise<import('fastify').FastifyInstance>}
   */
  async function readyApp() {
    const instance = buildApp(TEST_APP_CONFIG);
    await instance.ready();
    return instance;
  }

  /**
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} email Email.
   * @param {string} password Password.
   */
  async function login(instance, email, password) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/access/auth/login`,
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('exposes measured assistant metrics on GET messages and omits lastRunMetrics until present', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'ctx-proj-1' },
      payload: { name: 'Context HTTP', sourceType: 'upload' },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json().id;
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${projectId}`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'ctx-conv-1' },
      payload: { title: 'Metrics thread' },
    });
    const conversationId = created.json().id;
    const userRow = await Message.create({
      orgId: org._id,
      projectId,
      conversationId,
      role: 'user',
      content: 'Ask',
      messageStatus: 'completed',
    });
    const assistantRow = await Message.create({
      orgId: org._id,
      projectId,
      conversationId,
      role: 'assistant',
      content: 'Answer',
      messageStatus: 'completed',
    });

    const emptyContext = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversationContext/get/${projectId}/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(emptyContext.statusCode).toBe(200);
    expect(emptyContext.json().summaryPresent).toBe(false);
    expect(emptyContext.json().pinnedFactCount).toBe(0);
    expect(emptyContext.json().lastRunMetrics).toBeUndefined();
    expect(emptyContext.json().summaryUpdatedAt).toBeUndefined();

    await persistMessageContextMetrics(String(assistantRow._id), {
      measuredInputTokens: 40,
      validatedContextCapacity: 131072,
      maximumInputBudget: 80,
      reservedOutputTokens: 457,
      compactionActions: [],
    });

    const messages = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversation/listMessages/${projectId}/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(messages.statusCode).toBe(200);
    const items = messages.json().items;
    expect(items.find((item) => item.id === String(userRow._id)).contextMetrics).toBeUndefined();
    expect(items.find((item) => item.id === String(assistantRow._id)).contextMetrics.contextPercentUsed).toBe(0.5);

    const withMetrics = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversationContext/get/${projectId}/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(withMetrics.json().lastRunMetrics).toEqual({
      contextPercentUsed: 0.5,
      measuredInputTokens: 40,
      maximumInputBudget: 80,
    });

    await persistMessageContextMetrics(String(assistantRow._id), {
      measuredInputTokens: 11,
      validatedContextCapacity: 131072,
    });
    const noPercent = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversationContext/get/${projectId}/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(noPercent.json().lastRunMetrics.measuredInputTokens).toBe(11);
    expect(noPercent.json().lastRunMetrics.contextPercentUsed).toBeUndefined();
  });

  it('returns 404 for soft-deleted and other-owner context reads', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const admin = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/create`,
      headers: { authorization: `Bearer ${admin.accessToken}`, 'idempotency-key': 'ctx-proj-404' },
      payload: { name: 'Context 404', sourceType: 'upload' },
    });
    const projectId = project.json().id;
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${projectId}`,
      headers: { authorization: `Bearer ${admin.accessToken}`, 'idempotency-key': 'ctx-conv-404' },
      payload: { title: 'Private' },
    });
    const conversationId = created.json().id;

    const adminRole = await findRoleByCode(org._id, 'ADMIN');
    await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'ctx-other@example.com',
      displayName: 'Other',
      userStatus: 'active',
      passwordHash: await hashPassword('OtherAdmin1!'),
      roleIds: [adminRole._id],
      projectAccessMode: 'all',
    });
    const other = await login(app, 'ctx-other@example.com', 'OtherAdmin1!');
    const crossOwner = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversationContext/get/${projectId}/${conversationId}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(crossOwner.statusCode).toBe(404);
    expect(crossOwner.json().error.code).toBe('CONVERSATION_NOT_FOUND');

    await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/conversation/conversation/delete/${projectId}/${conversationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const deleted = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversationContext/get/${projectId}/${conversationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(deleted.statusCode).toBe(404);
    expect(deleted.json().error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('returns 403 without chat.ask', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const admin = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/create`,
      headers: { authorization: `Bearer ${admin.accessToken}`, 'idempotency-key': 'ctx-proj-auth' },
      payload: { name: 'Context auth', sourceType: 'upload' },
    });
    const projectId = project.json().id;
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${projectId}`,
      headers: { authorization: `Bearer ${admin.accessToken}`, 'idempotency-key': 'ctx-conv-auth' },
      payload: { title: 'Admin thread' },
    });
    const role = await createRoleInRepo(org._id, {
      code: 'NOCHATCTX',
      name: 'No chat context',
      permissions: ['org.view', 'projects.view'],
      createdBy: null,
    });
    const user = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'nochat-ctx@example.com',
      displayName: 'No Chat',
      passwordHash: await hashPassword('NoChatPass1!'),
      userStatus: 'active',
      createdBy: null,
      roleIds: [role._id],
    });
    await addProjectMember({
      orgId: String(org._id),
      projectId,
      userId: String(user._id),
      actorUserId: String(user._id),
      roleId: String(role._id),
      correlationId: 'corr-ctx-403',
      log: createMockLog(),
    });
    const denied = await login(app, 'nochat-ctx@example.com', 'NoChatPass1!');
    const forbidden = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversationContext/get/${projectId}/${created.json().id}`,
      headers: { authorization: `Bearer ${denied.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
