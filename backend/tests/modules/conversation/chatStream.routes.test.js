/**
 * Chat SSE POST route integration — Accept, gate, ACL, idempotency replay.
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

describe('chatStream routes', () => {
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
      args.onDelta?.('Checkout ');
      args.onEvidence?.([{ evidenceId: 'ev_01', path: 'a.js' }]);
      args.onDone?.({ messageId: args.input.scope.assistantMessageId });
      return { answerContent: 'Checkout works' };
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
   * Marks a project askable for the knowledge gate mock + health field.
   * @param {string} projectId Project id.
   * @param {string} orgId Org id.
   * @param {string} [health] knowledgeHealth.
   */
  async function markProjectReady(projectId, orgId, health = 'ready') {
    const sourceVersionId = new mongoose.Types.ObjectId();
    const version = await KnowledgeVersion.create({
      orgId,
      projectId,
      sourceVersionId,
      publishedHealth: health === 'partially_available' ? 'partially_available' : 'ready',
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
          knowledgeHealth: health,
          lifecycleStatus: health === 'partially_available' ? 'partially_available' : 'knowledge_ready',
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
   * @param {object} opts Headers/body overrides.
   */
  async function postMessage(instance, accessToken, projectId, conversationId, opts = {}) {
    /** @type {Record<string, string>} */
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: opts.accept ?? 'text/event-stream',
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    };
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/chatStream/streamMessage/${projectId}/${conversationId}`,
      headers,
      payload: opts.payload ?? { content: 'How does checkout work?' },
    });
  }

  it('streams status and done for an authorized ask', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'SSE Ready', 'idem-sse-proj-1');
    await markProjectReady(project.id, org._id);

    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${project.id}`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-sse-conv-1' },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().id;

    const res = await postMessage(app, accessToken, project.id, conversationId, {
      idempotencyKey: 'idem-sse-msg-1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const body = res.body;
    expect(body).toContain('event: status');
    expect(body).toContain('"stage":"accepted"');
    expect(body).toContain('event: done');
    expect(mockInvokeChatGraph).toHaveBeenCalledTimes(1);

    const assistants = await Message.find({ conversationId, role: 'assistant' });
    expect(assistants).toHaveLength(1);
  });

  it('returns 406 when Accept is not event-stream', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'SSE Accept', 'idem-sse-proj-406');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${project.id}`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-sse-conv-406' },
      payload: {},
    });

    const res = await postMessage(app, accessToken, project.id, created.json().id, {
      accept: 'application/json',
      idempotencyKey: 'idem-sse-msg-406',
    });
    expect(res.statusCode).toBe(406);
    expect(res.json().error.code).toBe('NOT_ACCEPTABLE');
    expect(mockInvokeChatGraph).not.toHaveBeenCalled();
  });

  it('returns 202 queued JSON when the gate queues (Accept not required)', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const project = await createProject(app, accessToken, 'SSE Updating', 'idem-sse-proj-upd');
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${project.id}`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-sse-conv-upd' },
      payload: {},
    });
    const conversationId = created.json().id;
    mockAssertKnowledgeReadable.mockResolvedValue({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });

    const res = await postMessage(app, accessToken, project.id, conversationId, {
      accept: 'application/json',
      idempotencyKey: 'idem-sse-msg-upd',
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json();
    expect(body.messageStatus).toBe('queued');
    expect(body.messageId).toBeTruthy();
    expect(body.queuedAt).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
    expect(mockInvokeChatGraph).not.toHaveBeenCalled();

    const queued = await Message.findById(body.messageId).lean();
    expect(queued?.messageStatus).toBe('queued');
    expect(queued?.role).toBe('user');

    const replay = await postMessage(app, accessToken, project.id, conversationId, {
      accept: 'application/json',
      idempotencyKey: 'idem-sse-msg-upd',
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().messageId).toBe(body.messageId);
    expect(mockInvokeChatGraph).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing conversation', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'SSE Missing', 'idem-sse-proj-404');
    await markProjectReady(project.id, org._id);

    const res = await postMessage(app, accessToken, project.id, new mongoose.Types.ObjectId().toString(), {
      idempotencyKey: 'idem-sse-msg-404',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('replays idempotent JSON without a second graph run', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'SSE Idem', 'idem-sse-proj-idem');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${project.id}`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-sse-conv-idem' },
      payload: {},
    });
    const conversationId = created.json().id;

    const first = await postMessage(app, accessToken, project.id, conversationId, {
      idempotencyKey: 'idem-sse-msg-replay',
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toMatch(/text\/event-stream/);
    expect(mockInvokeChatGraph).toHaveBeenCalledTimes(1);

    const second = await postMessage(app, accessToken, project.id, conversationId, {
      idempotencyKey: 'idem-sse-msg-replay',
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['content-type']).toMatch(/application\/json/);
    const replay = second.json();
    expect(replay.userMessageId).toBeTruthy();
    expect(replay.assistantMessageId).toBeTruthy();
    expect(replay.messageStatus).toBe('completed');
    expect(mockInvokeChatGraph).toHaveBeenCalledTimes(1);
  });

  it('emits clarification on graph interrupt', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'SSE Clarify', 'idem-sse-proj-clr');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${project.id}`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-sse-conv-clr' },
      payload: {},
    });
    mockInvokeChatGraph.mockResolvedValue({
      __interrupt__: [
        {
          value: {
            clarificationSetId: 'clr_test',
            roundIndex: 0,
            questions: [{ id: 'q1', type: 'free_text', prompt: 'Which service?' }],
            issuedAt: new Date().toISOString(),
          },
        },
      ],
    });

    const res = await postMessage(app, accessToken, project.id, created.json().id, {
      idempotencyKey: 'idem-sse-msg-clr',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: clarification');
    expect(res.body).toContain('clr_test');
    expect(res.body).toContain('"roundIndex":0');
    const assistant = await Message.findOne({ conversationId: created.json().id, role: 'assistant' });
    expect(assistant?.messageStatus).toBe('awaiting_clarification');
  });

  it('emits SSE error when the graph throws after headers', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'SSE Err', 'idem-sse-proj-err');
    await markProjectReady(project.id, org._id);
    const created = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create/${project.id}`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'idem-sse-conv-err' },
      payload: {},
    });
    const { ApiError } = await import('../../../src/platform/errors.js');
    mockInvokeChatGraph.mockRejectedValue(ApiError.fromCode('LLM_PROVIDER_ERROR'));

    const res = await postMessage(app, accessToken, project.id, created.json().id, {
      idempotencyKey: 'idem-sse-msg-err',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: error');
    expect(res.body).toContain('LLM_PROVIDER_ERROR');
    expect(res.body).toContain('"reference":');
    const correlation = res.headers['x-correlation-id'];
    if (typeof correlation === 'string') {
      expect(res.body).toContain(correlation);
    }
  });
});
