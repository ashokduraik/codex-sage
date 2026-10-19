/**
 * Chat SSE edit/retry route integration — replace downstream, author, retry, idempotency.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { KNOWLEDGE_MODELS } from '../../../src/modules/knowledge/index.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { KnowledgeVersion } from '../../../src/models/knowledgeVersion.model.js';
import { PROJECT_MODELS, Project } from '../../../src/modules/masters/projects.js';
import { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../../src/platform/data/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_MODELS, Message } from '../../../src/modules/conversation/conversation.js';
import {
  IDENTITY_MODELS,
  runBootstrapSeed,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  findOrganizationBySlug,
} from '../../../src/modules/masters/index.js';

const { mockInvokeChatGraph, mockAssertKnowledgeReadable } = vi.hoisted(() => ({
  mockInvokeChatGraph: vi.fn(),
  mockAssertKnowledgeReadable: vi.fn(),
}));

vi.mock('../../../src/modules/conversation/chatGraph.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    invokeChatGraph: (...args) => mockInvokeChatGraph(...args),
  };
});

vi.mock('../../../src/modules/knowledge/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    assertKnowledgeReadable: (...args) => mockAssertKnowledgeReadable(...args),
  };
});

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...AUTH_MODELS,
    ...AUDIT_MODELS,
    ...IDEMPOTENCY_MODELS,
    ...PROJECT_MODELS,
    ...CONVERSATION_MODELS,
    ...KNOWLEDGE_MODELS,
  ],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('chatStream edit/retry routes', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertKnowledgeReadable.mockResolvedValue({
      action: 'allow',
      knowledgeVersionId: new mongoose.Types.ObjectId().toString(),
    });
    mockInvokeChatGraph.mockImplementation(async (args) => {
      args.onStage?.({ stage: 'understanding_question' });
      args.onDelta?.('Edited ');
      // Mock replaces the real graph, so finalize the pending assistant the way the graph would.
      await Message.updateOne({ _id: args.input.scope.assistantMessageId }, { $set: { messageStatus: 'completed', content: 'Edited answer' } });
      args.onDone?.({ messageId: args.input.scope.assistantMessageId });
      return { answerContent: 'Edited answer' };
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
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
   */
  async function login(instance) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/access/auth/login`,
      payload: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /**
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} name Project name.
   * @param {string} idem Key.
   */
  async function createProject(instance, accessToken, name, idem) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': idem },
      payload: { name, sourceType: 'upload' },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  /**
   * @param {string} projectId Project id.
   * @param {string} orgId Org id.
   */
  async function markProjectReady(projectId, orgId) {
    const sourceVersionId = new mongoose.Types.ObjectId();
    const version = await KnowledgeVersion.create({
      orgId,
      projectId,
      sourceVersionId,
      publishedHealth: 'ready',
      excludedFileCount: 0,
      graphIdentity: {
        graphHash: 'test-hash',
        indexedAt: new Date().toISOString(),
        sourceVersionId: String(sourceVersionId),
        indexedFileCount: 1,
        skippedFileCount: 0,
        mode: 'indexAll',
        graphDir: '.codegraph',
      },
    });
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          knowledgeHealth: 'ready',
          lifecycleStatus: 'knowledge_ready',
          currentKnowledgeVersionId: version._id,
        },
      },
    );
    mockAssertKnowledgeReadable.mockResolvedValue({
      action: 'allow',
      knowledgeVersionId: String(version._id),
    });
  }

  /**
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} projectId Project id.
   * @param {string} conversationId Conversation id.
   * @param {object} opts Overrides.
   */
  async function postMessage(instance, accessToken, projectId, conversationId, opts = {}) {
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/chatStream/streamMessage`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': opts.idempotencyKey ?? `idem-send-${Date.now()}`,
      },
      payload: { projectId, conversationId, ...(opts.payload ?? { content: 'How does checkout work?' }) },
    });
  }

  /**
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} projectId Project id.
   * @param {string} conversationId Conversation id.
   * @param {string} messageId Message id.
   * @param {object} opts Overrides.
   */
  async function postEdit(instance, accessToken, projectId, conversationId, messageId, opts = {}) {
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/chatStream/editMessage`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: opts.accept ?? 'text/event-stream',
        'idempotency-key': opts.idempotencyKey ?? `idem-edit-${Date.now()}`,
      },
      payload: { projectId, conversationId, messageId, ...(opts.payload ?? { content: 'Edited checkout question?' }) },
    });
  }

  /**
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} projectId Project id.
   * @param {string} conversationId Conversation id.
   * @param {string} messageId Message id.
   * @param {object} opts Overrides.
   */
  async function postRetry(instance, accessToken, projectId, conversationId, messageId, opts = {}) {
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/chatStream/retryMessage`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: opts.accept ?? 'text/event-stream',
        'idempotency-key': opts.idempotencyKey ?? `idem-retry-${Date.now()}`,
      },
      payload: { projectId, conversationId, messageId },
    });
  }

  it('edits U1, soft-deletes later turns, and streams a new assistant answer', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Edit Ready', 'idem-edit-proj-1');
    await markProjectReady(project.id, org._id);

    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-edit-conv-1' },
      payload: { projectId: project.id },
    });
    const conversationId = created.json().id;

    const first = await postMessage(app, accessToken, project.id, conversationId, {
      idempotencyKey: 'idem-edit-send-1',
      payload: { content: 'First question' },
    });
    expect(first.statusCode).toBe(200);

    const second = await postMessage(app, accessToken, project.id, conversationId, {
      idempotencyKey: 'idem-edit-send-2',
      payload: { content: 'Second question' },
    });
    expect(second.statusCode).toBe(200);

    const users = await Message.find({ conversationId, role: 'user', status: ROW_STATUS_ACTIVE }).sort({ createdAt: 1 });
    expect(users).toHaveLength(2);
    const u1 = users[0];

    mockInvokeChatGraph.mockClear();
    const edit = await postEdit(app, accessToken, project.id, conversationId, String(u1._id), {
      idempotencyKey: 'idem-edit-msg-1',
      payload: { content: 'Edited first question' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.headers['content-type']).toMatch(/text\/event-stream/);
    expect(edit.body).toContain('"stage":"accepted"');
    expect(edit.body).toContain('removedMessageIds');
    expect(mockInvokeChatGraph).toHaveBeenCalledTimes(1);

    const active = await Message.find({ conversationId, status: ROW_STATUS_ACTIVE }).sort({ createdAt: 1 });
    expect(active).toHaveLength(2);
    expect(active[0].role).toBe('user');
    expect(active[0].content).toBe('Edited first question');
    expect(active[0].editGeneration).toBe(1);
    expect(active[1].role).toBe('assistant');
    expect(active[1].messageStatus).toBe('completed');

    const deleted = await Message.find({ conversationId, status: ROW_STATUS_DELETED });
    expect(deleted.length).toBeGreaterThanOrEqual(2);

    const list = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversation/listMessages/${project.id}/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(2);
    expect(list.json().items[0].editGeneration).toBe(1);
  });

  it('returns 409 when editing an assistant message', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Edit Assistant', 'idem-edit-proj-asst');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-edit-conv-asst' },
      payload: { projectId: project.id },
    });
    const conversationId = created.json().id;
    await postMessage(app, accessToken, project.id, conversationId, { idempotencyKey: 'idem-edit-send-asst' });
    const assistant = await Message.findOne({ conversationId, role: 'assistant' });

    const res = await postEdit(app, accessToken, project.id, conversationId, String(assistant._id), {
      idempotencyKey: 'idem-edit-asst',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('returns 409 when editing while an assistant is generating', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Edit Inflight', 'idem-edit-proj-inf');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-edit-conv-inf' },
      payload: { projectId: project.id },
    });
    const conversationId = created.json().id;
    await postMessage(app, accessToken, project.id, conversationId, { idempotencyKey: 'idem-edit-send-inf' });
    const user = await Message.findOne({ conversationId, role: 'user' });
    await Message.create({
      orgId: org._id,
      projectId: project.id,
      conversationId,
      role: 'assistant',
      content: '\u200b',
      messageStatus: 'generating',
      createdBy: user.createdBy,
      updatedBy: user.createdBy,
    });

    const res = await postEdit(app, accessToken, project.id, conversationId, String(user._id), {
      idempotencyKey: 'idem-edit-inf',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MESSAGE_NOT_EDITABLE');
  });

  it('retries a failed latest assistant without changing the user question', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Retry Ready', 'idem-retry-proj-1');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-retry-conv-1' },
      payload: { projectId: project.id },
    });
    const conversationId = created.json().id;
    await postMessage(app, accessToken, project.id, conversationId, {
      idempotencyKey: 'idem-retry-send-1',
      payload: { content: 'Retry me' },
    });

    const user = await Message.findOne({ conversationId, role: 'user' });
    const assistant = await Message.findOne({ conversationId, role: 'assistant' });
    await Message.updateOne({ _id: assistant._id }, { $set: { messageStatus: 'failed', content: '' } });

    mockInvokeChatGraph.mockClear();
    const retry = await postRetry(app, accessToken, project.id, conversationId, String(assistant._id), {
      idempotencyKey: 'idem-retry-msg-1',
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['content-type']).toMatch(/text\/event-stream/);
    expect(mockInvokeChatGraph).toHaveBeenCalledTimes(1);

    const userAfter = await Message.findById(user._id);
    expect(userAfter?.content).toBe('Retry me');
    expect(userAfter?.status).toBe(ROW_STATUS_ACTIVE);

    const failed = await Message.findOne({ _id: assistant._id, status: ROW_STATUS_DELETED });
    expect(failed?.status).toBe(ROW_STATUS_DELETED);

    const activeAssistants = await Message.find({ conversationId, role: 'assistant', status: ROW_STATUS_ACTIVE });
    expect(activeAssistants).toHaveLength(1);
    expect(activeAssistants[0].messageStatus).toBe('completed');
    expect(String(activeAssistants[0].parentMessageId)).toBe(String(user._id));
  });

  it('returns 409 when retrying a completed assistant', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Retry Done', 'idem-retry-proj-done');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-retry-conv-done' },
      payload: { projectId: project.id },
    });
    const conversationId = created.json().id;
    await postMessage(app, accessToken, project.id, conversationId, { idempotencyKey: 'idem-retry-send-done' });
    const assistant = await Message.findOne({ conversationId, role: 'assistant' });

    const res = await postRetry(app, accessToken, project.id, conversationId, String(assistant._id), {
      idempotencyKey: 'idem-retry-done',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MESSAGE_NOT_RETRYABLE');
  });

  it('replays idempotent edit JSON without a second graph run', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Edit Idem', 'idem-edit-proj-idem');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-edit-conv-idem' },
      payload: { projectId: project.id },
    });
    const conversationId = created.json().id;
    await postMessage(app, accessToken, project.id, conversationId, { idempotencyKey: 'idem-edit-send-idem' });
    const user = await Message.findOne({ conversationId, role: 'user' });

    mockInvokeChatGraph.mockClear();
    const first = await postEdit(app, accessToken, project.id, conversationId, String(user._id), {
      idempotencyKey: 'idem-edit-replay',
      payload: { content: 'Idempotent edit' },
    });
    expect(first.statusCode).toBe(200);
    expect(mockInvokeChatGraph).toHaveBeenCalledTimes(1);

    const second = await postEdit(app, accessToken, project.id, conversationId, String(user._id), {
      idempotencyKey: 'idem-edit-replay',
      payload: { content: 'Idempotent edit' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['content-type']).toMatch(/application\/json/);
    expect(second.json().userMessageId).toBe(String(user._id));
    expect(second.json().editGeneration).toBe(1);
    expect(mockInvokeChatGraph).toHaveBeenCalledTimes(1);
  });

  it('updates queued user content without SSE when still queued', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const project = await createProject(app, accessToken, 'Edit Queued', 'idem-edit-proj-q');
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-edit-conv-q' },
      payload: { projectId: project.id },
    });
    const conversationId = created.json().id;
    mockAssertKnowledgeReadable.mockResolvedValue({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });

    const queued = await postMessage(app, accessToken, project.id, conversationId, {
      idempotencyKey: 'idem-edit-send-q',
    });
    expect(queued.statusCode).toBe(202);
    const messageId = queued.json().messageId;

    const edit = await postEdit(app, accessToken, project.id, conversationId, messageId, {
      accept: 'application/json',
      idempotencyKey: 'idem-edit-q',
      payload: { content: 'Updated while queued' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().messageStatus).toBe('queued');
    expect(edit.json().editGeneration).toBe(1);
    expect(mockInvokeChatGraph).not.toHaveBeenCalled();

    const row = await Message.findById(messageId);
    expect(row?.content).toBe('Updated while queued');
    expect(row?.messageStatus).toBe('queued');
  });

  it('returns 404 for cross-tenant missing conversation on edit', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Edit 404', 'idem-edit-proj-404');
    await markProjectReady(project.id, org._id);

    const res = await postEdit(app, accessToken, project.id, new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString(), {
      idempotencyKey: 'idem-edit-404',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CONVERSATION_NOT_FOUND');
  });
});
