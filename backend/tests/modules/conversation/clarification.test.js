/**
 * Clarification set persistence, answer validation, and answer SSE resume route.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { ApiError } from '../../../src/platform/errors.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { KNOWLEDGE_MODELS } from '../../../src/modules/knowledge/index.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { KnowledgeVersion } from '../../../src/models/knowledgeVersion.model.js';
import { PROJECT_MODELS, Project } from '../../../src/modules/masters/projects.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLARIFICATION_MAX_ROUNDS } from '../../../src/modules/conversation/chatGraph.helper.js';
import {
  IDENTITY_MODELS,
  runBootstrapSeed,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  findOrganizationBySlug,
} from '../../../src/modules/masters/index.js';
import {
  Message,
  ClarificationSet,
  CONVERSATION_MODELS,
  validateClarificationAnswers,
  loadOpenClarificationsForMessages,
  CLARIFICATION_FREE_TEXT_MAX_LENGTH,
  persistOpenClarificationSetFromInterrupt,
} from '../../../src/modules/conversation/index.js';

const { mockResumeChatGraphFromClarification, mockInvokeChatGraph, mockAssertKnowledgeReadable, finalizeAssistantMessageState } = vi.hoisted(() => ({
  mockResumeChatGraphFromClarification: vi.fn(),
  mockInvokeChatGraph: vi.fn(),
  mockAssertKnowledgeReadable: vi.fn(),
  finalizeAssistantMessageState: { rejectAfter: 0, callCount: 0 },
}));

vi.mock('../../../src/modules/conversation/chatGraph.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    invokeChatGraph: (...args) => mockInvokeChatGraph(...args),
    resumeChatGraphFromClarification: (...args) => mockResumeChatGraphFromClarification(...args),
  };
});

vi.mock('../../../src/modules/knowledge/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    assertKnowledgeReadable: (...args) => mockAssertKnowledgeReadable(...args),
  };
});

vi.mock('../../../src/modules/conversation/conversation.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    finalizeAssistantMessage: async (...args) => {
      finalizeAssistantMessageState.callCount += 1;
      if (finalizeAssistantMessageState.rejectAfter > 0 && finalizeAssistantMessageState.callCount === finalizeAssistantMessageState.rejectAfter) {
        throw new Error('forced finalize failure');
      }
      return actual.finalizeAssistantMessage(...args);
    },
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

describe('validateClarificationAnswers', () => {
  const questions = [
    { id: 'q1', type: 'single_select', prompt: 'Auth?', options: ['JWT', 'session'], required: true },
    { id: 'q2', type: 'multi_select', prompt: 'Envs?', options: ['dev', 'prod'], required: true },
    { id: 'q3', type: 'free_text', prompt: 'Path?', required: true },
  ];

  it('accepts a valid answer map for all three types', () => {
    const normalised = validateClarificationAnswers(questions, {
      q1: 'JWT',
      q2: ['dev', 'prod'],
      q3: '  services/payments  ',
    });
    expect(normalised).toEqual({
      q1: 'JWT',
      q2: ['dev', 'prod'],
      q3: 'services/payments',
    });
  });

  it('rejects an invalid single_select option', () => {
    expect(() =>
      validateClarificationAnswers(questions, {
        q1: 'oauth',
        q2: ['dev'],
        q3: 'x',
      }),
    ).toThrow(ApiError);
    try {
      validateClarificationAnswers(questions, { q1: 'oauth', q2: ['dev'], q3: 'x' });
    } catch (error) {
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'answers.q1' })]));
    }
  });

  it('rejects overlong free_text', () => {
    expect(() =>
      validateClarificationAnswers(questions, {
        q1: 'JWT',
        q2: ['dev'],
        q3: 'x'.repeat(CLARIFICATION_FREE_TEXT_MAX_LENGTH + 1),
      }),
    ).toThrow(ApiError);
  });

  it('rejects missing required answers', () => {
    expect(() => validateClarificationAnswers(questions, { q1: 'JWT' })).toThrow(ApiError);
  });

  it('rejects multi_select when value is not an array', () => {
    expect(() => validateClarificationAnswers(questions, { q1: 'JWT', q2: 'dev', q3: 'x' })).toThrow(ApiError);
  });

  it('allows omitting optional questions', () => {
    const optional = [
      { id: 'q1', type: 'free_text', prompt: 'Optional?', required: false },
      { id: 'q2', type: 'free_text', prompt: 'Required?', required: true },
    ];
    expect(validateClarificationAnswers(optional, { q2: 'yes' })).toEqual({ q2: 'yes' });
  });

  it('rejects unknown question types', () => {
    expect(() =>
      validateClarificationAnswers([{ id: 'q1', type: 'ranking', prompt: '?', required: true }], {
        q1: 'x',
      }),
    ).toThrow(ApiError);
  });

  it('rejects empty multi_select when required and invalid option membership', () => {
    expect(() => validateClarificationAnswers(questions, { q1: 'JWT', q2: [], q3: 'x' })).toThrow(ApiError);
    expect(() => validateClarificationAnswers(questions, { q1: 'JWT', q2: ['staging'], q3: 'x' })).toThrow(ApiError);
  });

  it('rejects free_text when not a string or blank when required', () => {
    expect(() => validateClarificationAnswers(questions, { q1: 'JWT', q2: ['dev'], q3: ['nope'] })).toThrow(ApiError);
    expect(() => validateClarificationAnswers(questions, { q1: 'JWT', q2: ['dev'], q3: '   ' })).toThrow(ApiError);
  });

  it('rejects single_select when value is not a string', () => {
    expect(() => validateClarificationAnswers(questions, { q1: ['JWT'], q2: ['dev'], q3: 'x' })).toThrow(ApiError);
  });
});

describe('persistOpenClarificationSetFromInterrupt', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('persists an open set and supersedes a prior open set on the same message', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    const orgId = String(org._id);
    const projectId = new mongoose.Types.ObjectId().toString();
    const conversationId = new mongoose.Types.ObjectId().toString();
    const messageId = new mongoose.Types.ObjectId().toString();
    const actorUserId = new mongoose.Types.ObjectId().toString();

    await persistOpenClarificationSetFromInterrupt({
      orgId,
      projectId,
      conversationId,
      messageId,
      actorUserId,
      clarificationSet: {
        clarificationSetId: 'clr_r0_first',
        roundIndex: 0,
        questions: [{ id: 'q1', type: 'free_text', prompt: 'Which?' }],
        issuedAt: new Date().toISOString(),
      },
    });

    await persistOpenClarificationSetFromInterrupt({
      orgId,
      projectId,
      conversationId,
      messageId,
      actorUserId,
      clarificationSet: {
        clarificationSetId: 'clr_r1_second',
        roundIndex: 1,
        questions: [{ id: 'q1', type: 'free_text', prompt: 'More?' }],
        issuedAt: new Date().toISOString(),
      },
    });

    const open = await ClarificationSet.find({ orgId, messageId, setStatus: 'open' }).lean();
    expect(open).toHaveLength(1);
    expect(open[0].clarificationSetId).toBe('clr_r1_second');

    const superseded = await ClarificationSet.findOne({ clarificationSetId: 'clr_r0_first' }).setOptions({ includeDeleted: true }).lean();
    expect(superseded?.setStatus).toBe('superseded');
    expect(superseded?.status).toBe('D');
  });

  it('rejects roundIndex at or above CLARIFICATION_MAX_ROUNDS', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    await expect(
      persistOpenClarificationSetFromInterrupt({
        orgId: String(org._id),
        projectId: new mongoose.Types.ObjectId().toString(),
        conversationId: new mongoose.Types.ObjectId().toString(),
        messageId: new mongoose.Types.ObjectId().toString(),
        actorUserId: new mongoose.Types.ObjectId().toString(),
        clarificationSet: {
          clarificationSetId: 'clr_too_many',
          roundIndex: CLARIFICATION_MAX_ROUNDS,
          questions: [{ id: 'q1', type: 'free_text', prompt: 'Nope' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'CLARIFICATION_ROUND_EXCEEDED' });
  });

  it('rejects missing clarificationSetId', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    await expect(
      persistOpenClarificationSetFromInterrupt({
        orgId: String(org._id),
        projectId: new mongoose.Types.ObjectId().toString(),
        conversationId: new mongoose.Types.ObjectId().toString(),
        messageId: new mongoose.Types.ObjectId().toString(),
        actorUserId: new mongoose.Types.ObjectId().toString(),
        clarificationSet: { questions: [] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns an empty map for empty or invalid message ids', async () => {
    const empty = await loadOpenClarificationsForMessages(new mongoose.Types.ObjectId().toString(), []);
    expect(empty.size).toBe(0);
    const invalid = await loadOpenClarificationsForMessages(new mongoose.Types.ObjectId().toString(), ['not-an-objectid']);
    expect(invalid.size).toBe(0);
  });

  it('persists with Date issuedAt and null actor', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    const messageId = new mongoose.Types.ObjectId().toString();
    const row = await persistOpenClarificationSetFromInterrupt({
      orgId: String(org._id),
      projectId: new mongoose.Types.ObjectId().toString(),
      conversationId: new mongoose.Types.ObjectId().toString(),
      messageId,
      actorUserId: null,
      clarificationSet: {
        clarificationSetId: 'clr_date_actor',
        questions: [{ id: 'q1', type: 'free_text', prompt: 'Hi', options: undefined }],
        issuedAt: new Date(),
      },
    });
    expect(row.roundIndex).toBe(0);
    expect(row.createdBy).toBeNull();
    const map = await loadOpenClarificationsForMessages(String(org._id), [messageId]);
    expect(map.get(messageId)?.clarificationSetId).toBe('clr_date_actor');
  });

  it('normalises questions without ids and non-array questions input', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    const row = await persistOpenClarificationSetFromInterrupt({
      orgId: String(org._id),
      projectId: new mongoose.Types.ObjectId().toString(),
      conversationId: new mongoose.Types.ObjectId().toString(),
      messageId: new mongoose.Types.ObjectId().toString(),
      actorUserId: new mongoose.Types.ObjectId().toString(),
      clarificationSet: {
        clarificationSetId: 'clr_norm_q',
        questions: [{ type: 'free_text', prompt: 'Need id', options: ['a', 2] }],
      },
    });
    expect(row.questions[0].id).toBe('q1');
    expect(row.questions[0].options).toEqual(['a', '2']);

    const emptyQuestions = await persistOpenClarificationSetFromInterrupt({
      orgId: String(org._id),
      projectId: new mongoose.Types.ObjectId().toString(),
      conversationId: new mongoose.Types.ObjectId().toString(),
      messageId: new mongoose.Types.ObjectId().toString(),
      actorUserId: new mongoose.Types.ObjectId().toString(),
      clarificationSet: {
        clarificationSetId: 'clr_norm_empty',
        questions: null,
      },
    });
    expect(emptyQuestions.questions).toEqual([]);
  });

  it('skips supersede when messageId is not a valid ObjectId then fails create', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    await expect(
      persistOpenClarificationSetFromInterrupt({
        orgId: String(org._id),
        projectId: new mongoose.Types.ObjectId().toString(),
        conversationId: new mongoose.Types.ObjectId().toString(),
        messageId: 'not-valid',
        actorUserId: 'also-bad',
        clarificationSet: {
          clarificationSetId: 'clr_bad_msg',
          questions: [{ id: 'q1', type: 'free_text', prompt: 'Hi' }],
        },
      }),
    ).rejects.toBeTruthy();
  });
});

describe('clarification answer routes', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    finalizeAssistantMessageState.rejectAfter = 0;
    finalizeAssistantMessageState.callCount = 0;
    mockAssertKnowledgeReadable.mockResolvedValue({
      action: 'allow',
      knowledgeVersionId: new mongoose.Types.ObjectId().toString(),
    });
    mockResumeChatGraphFromClarification.mockImplementation(async (args) => {
      args.onStage?.({ stage: 'understanding_question' });
      args.onDelta?.('Resumed ');
      args.onDelta?.('');
      args.onEvidence?.([{ evidenceId: 'ev_01' }]);
      args.onDone?.({ messageId: args.threadId.split(':').pop() });
      return { answerContent: 'Resumed answer', supportLevel: 'evidence_backed' };
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
   * Creates a conversation, streams until clarify interrupt, returns ids.
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} projectId Project id.
   * @param {string} idemPrefix Idempotency key prefix.
   */
  async function interruptWithClarification(instance, accessToken, projectId, idemPrefix) {
    const created = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/conversation/create`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': `${idemPrefix}-conv` },
      payload: { projectId },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().id;

    mockInvokeChatGraph.mockResolvedValue({
      __interrupt__: [
        {
          value: {
            clarificationSetId: 'clr_route_test',
            roundIndex: 0,
            questions: [{ id: 'q1', type: 'single_select', prompt: 'Which?', options: ['A', 'B'], required: true }],
            issuedAt: new Date().toISOString(),
          },
        },
      ],
    });

    const stream = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/chatStream/streamMessage`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': `${idemPrefix}-msg`,
      },
      payload: { projectId, conversationId, content: 'Need clarify' },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain('event: clarification');
    expect(stream.body).toContain('"roundIndex":0');

    const assistant = await Message.findOne({ conversationId, role: 'assistant' });
    expect(assistant?.messageStatus).toBe('awaiting_clarification');
    return { conversationId, messageId: String(assistant._id) };
  }

  /**
   * POST clarification answers (ids in body; path is project + conversation only).
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} projectId Project id.
   * @param {string} conversationId Conversation id.
   * @param {{
   *   messageId: string,
   *   clarificationSetId?: string,
   *   answers?: Record<string, string | string[]>,
   *   idempotencyKey: string,
   *   accept?: string | string[],
   *   payload?: object,
   * }} opts Request options.
   */
  async function postClarificationAnswer(instance, accessToken, projectId, conversationId, opts) {
    /** @type {Record<string, string | string[]>} */
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: opts.accept ?? 'text/event-stream',
      'idempotency-key': opts.idempotencyKey,
    };
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers,
      payload: {
        projectId,
        ...(opts.payload ?? {
          conversationId,
          messageId: opts.messageId,
          clarificationSetId: opts.clarificationSetId ?? 'clr_route_test',
          answers: opts.answers ?? { q1: 'A' },
        }),
      },
    });
  }

  it('embeds open clarification on listMessages and resumes via answer SSE', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify API', 'idem-clr-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr');

    const listed = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/conversation/conversation/listMessages/${project.id}/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listed.statusCode).toBe(200);
    const assistantDto = listed.json().items.find((item) => item.id === messageId);
    expect(assistantDto.clarification).toEqual(
      expect.objectContaining({
        clarificationSetId: 'clr_route_test',
        roundIndex: 0,
      }),
    );

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain('event: done');
    expect(mockResumeChatGraphFromClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      }),
    );

    const assistant = await Message.findById(messageId);
    expect(assistant?.messageStatus).toBe('completed');
    const setRow = await ClarificationSet.findOne({ clarificationSetId: 'clr_route_test' });
    expect(setRow?.setStatus).toBe('answered');
    expect(setRow?.answers).toEqual({ q1: 'A' });
  });

  it('returns 406 without Accept text/event-stream', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify 406', 'idem-clr406-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr406');

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'idempotency-key': 'idem-clr406-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(res.statusCode).toBe(406);
    expect(res.json().error.code).toBe('NOT_ACCEPTABLE');

    const emptyAccept = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: '',
        'idempotency-key': 'idem-clr406-empty',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(emptyAccept.statusCode).toBe(406);
  });

  it('returns 409 when the set is already answered', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify 409', 'idem-clr409-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr409');

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr409-a1',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr409-a2',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'B' },
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CLARIFICATION_NOT_OPEN');
  });

  it('returns 400 for invalid params and wrong answer option', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify Params', 'idem-clr-params-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-params');

    const badParams = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-params-bad',
      },
      payload: {
        projectId: project.id,
        conversationId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(badParams.statusCode).toBe(400);

    const badOption = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: ['text/event-stream'],
        'idempotency-key': 'idem-clr-params-opt',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'Z' },
      },
    });
    expect(badOption.statusCode).toBe(400);
    expect(badOption.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for invalid message ObjectId and 409 when message is not awaiting', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify State', 'idem-clr-state-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-state');

    const badId = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-state-badid',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId: 'not-an-id',
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(badId.statusCode).toBe(404);

    await Message.updateOne({ _id: messageId }, { $set: { messageStatus: 'completed' } });
    const notAwaiting = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-state-done',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(notAwaiting.statusCode).toBe(409);
    expect(notAwaiting.json().error.code).toBe('CLARIFICATION_NOT_OPEN');
  });

  it('returns 400 for invalid answer body and 404 for unknown clarificationSetId', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify Valid', 'idem-clr-val-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-val');

    const missingAnswers = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-val-empty',
      },
      payload: { projectId: project.id, conversationId, messageId, clarificationSetId: 'clr_route_test' },
    });
    expect(missingAnswers.statusCode).toBe(400);

    const badBody = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-val-bad',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
        extra: true,
      },
    });
    expect(badBody.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-val-404',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_missing',
        answers: { q1: 'A' },
      },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('emits a second clarification event when resume interrupts again', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify R2', 'idem-clr-r2-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-r2');

    mockResumeChatGraphFromClarification.mockResolvedValue({
      __interrupt__: [
        {
          value: {
            clarificationSetId: 'clr_r1_followup',
            roundIndex: 1,
            questions: [{ id: 'q1', type: 'free_text', prompt: 'More?', required: true }],
            issuedAt: new Date().toISOString(),
          },
        },
      ],
    });

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-r2-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain('event: clarification');
    expect(answer.body).toContain('clr_r1_followup');
    const assistant = await Message.findById(messageId);
    expect(assistant?.messageStatus).toBe('awaiting_clarification');
  });

  it('emits done when resume returns without calling onDone', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify NoDone', 'idem-clr-nodone-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-nodone');

    mockResumeChatGraphFromClarification.mockResolvedValue({
      answerContent: 'Silent complete',
      supportLevel: 'evidence_backed',
    });

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-nodone-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain('event: done');
    const assistant = await Message.findById(messageId);
    expect(assistant?.messageStatus).toBe('completed');
  });

  it('handles interrupt payload without a clarification set value', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify EmptyInt', 'idem-clr-emptyint-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-emptyint');

    mockResumeChatGraphFromClarification.mockResolvedValue({
      __interrupt__: [{}],
    });

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-emptyint-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    const assistant = await Message.findById(messageId);
    expect(assistant?.messageStatus).toBe('awaiting_clarification');
  });

  it('finalizes abstained when resume returns abstain_early', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify Abstain', 'idem-clr-abs-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-abs');

    mockResumeChatGraphFromClarification.mockResolvedValue({
      answerContent: '',
      route: 'abstain_early',
      supportLevel: 'insufficient',
    });

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-abs-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain('event: done');
    const assistant = await Message.findById(messageId);
    expect(assistant?.messageStatus).toBe('abstained');
  });

  it('emits SSE error when resume throws after headers', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify Err', 'idem-clr-err-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-err');

    mockResumeChatGraphFromClarification.mockRejectedValue(new Error('resume boom'));

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-err-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain('event: error');
    const assistant = await Message.findById(messageId);
    expect(assistant?.messageStatus).toBe('failed');
  });

  it('skips terminal finalize when onError marked the run failed', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify OnErr', 'idem-clr-onerr-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-onerr');

    mockResumeChatGraphFromClarification.mockImplementation(async (args) => {
      args.onError?.(new Error('soft graph error'));
      return { answerContent: 'ignored' };
    });

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-onerr-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain('event: error');
  });

  it('survives finalize failure after a successful resume return', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify FinFail', 'idem-clr-finfail-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-finfail');

    mockResumeChatGraphFromClarification.mockResolvedValue({
      answerContent: 'ok',
      supportLevel: 'evidence_backed',
    });
    // Call 1: prepare → generating; call 2: terminal finalize fails
    finalizeAssistantMessageState.callCount = 0;
    finalizeAssistantMessageState.rejectAfter = 2;

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-finfail-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
  });

  it('survives nested finalize failure while marking failed after resume throw', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify NestFail', 'idem-clr-nestfail-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-nestfail');

    mockResumeChatGraphFromClarification.mockRejectedValue(new Error('resume boom'));
    // Call 1: prepare → generating; call 2: mark failed in catch → reject
    finalizeAssistantMessageState.callCount = 0;
    finalizeAssistantMessageState.rejectAfter = 2;

    const answer = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-nestfail-answer',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain('event: error');
  });

  it('replays idempotent answer outcome as JSON', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Clarify Idem', 'idem-clr-idem-proj');
    await markProjectReady(project.id, org._id);
    const { conversationId, messageId } = await interruptWithClarification(app, accessToken, project.id, 'idem-clr-idem');

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-answer-replay',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toMatch(/text\/event-stream/);

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/conversation/clarification/answer`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream',
        'idempotency-key': 'idem-clr-answer-replay',
      },
      payload: {
        projectId: project.id,
        conversationId,
        messageId,
        clarificationSetId: 'clr_route_test',
        answers: { q1: 'A' },
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['content-type']).toMatch(/application\/json/);
    expect(second.json()).toEqual(
      expect.objectContaining({
        messageId,
        clarificationSetId: 'clr_route_test',
        messageStatus: 'completed',
      }),
    );
    expect(mockResumeChatGraphFromClarification).toHaveBeenCalledTimes(1);
  });
});
