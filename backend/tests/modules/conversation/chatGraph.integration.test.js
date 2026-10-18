/**
 * Mongo integration tests for chatCheckpoints, clarify resume, and persist.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { Message } from '../../../src/models/messages.model.js';
import { Conversation } from '../../../src/models/conversations.model.js';
import { ChatCheckpoint } from '../../../src/models/chatCheckpoint.model.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invokeChatGraph,
  compileChatGraph,
  buildChatGraphThreadId,
  createMongoChatCheckpointer,
  resumeChatGraphFromClarification,
} from '../../../src/modules/conversation/chatGraph.js';

const { mockGenerateText, mockStreamText, mockBuildConversationContext, mockExecuteTool, mockGetRunBudgetConfig, mockFindProjectById } = vi.hoisted(
  () => ({
    mockGenerateText: vi.fn(),
    mockStreamText: vi.fn(),
    mockBuildConversationContext: vi.fn(),
    mockExecuteTool: vi.fn(),
    mockGetRunBudgetConfig: vi.fn(),
    mockFindProjectById: vi.fn(),
  }),
);

vi.mock('../../../src/modules/conversation/llm.js', () => ({
  generateText: (...args) => mockGenerateText(...args),
  streamText: (...args) => mockStreamText(...args),
  assertLlmAvailable: vi.fn(),
  getLlmConfigStatus: vi.fn(),
  INFERENCE_QUEUE_MAX_CONCURRENCY: 1,
  INFERENCE_QUEUE_MAX_DEPTH: 8,
}));

vi.mock('../../../src/modules/conversation/conversationContext.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildConversationContext: (...args) => mockBuildConversationContext(...args),
  };
});

vi.mock('../../../src/modules/conversation/agentTools.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeTool: (...args) => mockExecuteTool(...args),
  };
});

vi.mock('../../../src/modules/conversation/runBudget.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getRunBudgetConfig: (...args) => mockGetRunBudgetConfig(...args),
  };
});

vi.mock('../../../src/modules/masters/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findProjectById: (...args) => mockFindProjectById(...args),
  };
});

const harness = createMongoHarness({
  models: [ChatCheckpoint, Conversation, Message],
  uri: TEST_APP_CONFIG.mongo.uri,
});

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const conversationId = new mongoose.Types.ObjectId();
const assistantMessageId = new mongoose.Types.ObjectId();

/**
 * @returns {object}
 */
function scope() {
  return {
    orgId: String(orgId),
    projectId: new mongoose.Types.ObjectId().toString(),
    userId: new mongoose.Types.ObjectId().toString(),
    conversationId: String(conversationId),
    userMessageId: new mongoose.Types.ObjectId().toString(),
    assistantMessageId: String(assistantMessageId),
    knowledgeVersionId: new mongoose.Types.ObjectId().toString(),
    correlationId: 'corr-int',
    workspaceRoot: '/tmp/codex-sage-workspace',
    budgetState: {
      modelArtifactRef: 'test-model',
      options: {
        validatedContextCapacity: 10_000,
        reservedOutputTokens: 0,
        llm: { contextCapacity: 10_000, artifactId: 'test-model' },
      },
    },
  };
}

describe('chatGraph Mongo checkpointer', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRunBudgetConfig.mockReturnValue({
      maxCumulativeInputTokens: null,
      maxCumulativeOutputTokens: null,
      maxCumulativeToolResultBytes: null,
      maxTotalCalls: null,
      maxWallTimeMs: null,
    });
    mockBuildConversationContext.mockResolvedValue({
      segments: [],
      summarySegment: undefined,
      pinnedSegments: [],
      recentMessageIds: [],
    });
    mockExecuteTool.mockResolvedValue({
      evidenceRecords: [],
      rejected: [],
      usage: { resultBytes: 0, promptTokensAfterBudget: 0 },
    });
    mockFindProjectById.mockResolvedValue({
      name: 'Payments API',
      description: 'Handles card refunds.',
    });
    mockStreamText.mockResolvedValue({
      textStream: (async function* streamChunks() {
        yield 'Login uses JWT per ev_01.';
      })(),
      usage: Promise.resolve({ inputTokens: 4, outputTokens: 3, totalTokens: null }),
      durationMs: Promise.resolve(9),
      modelId: 'test-model',
      contextMetrics: { measuredInputTokens: 4 },
      enableThinking: true,
    });
    mockGenerateText.mockImplementation(async (request) => {
      if (request.purpose === 'tool_choice') {
        return {
          text: JSON.stringify({ action: 'finish_retrieval' }),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: null },
          durationMs: 1,
          modelId: 'test-model',
          contextMetrics: {},
          enableThinking: false,
        };
      }
      if (request.purpose === 'verify') {
        return {
          text: JSON.stringify({ result: 'pass', failures: [] }),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: null },
          durationMs: 1,
          modelId: 'test-model',
          contextMetrics: {},
          enableThinking: true,
        };
      }
      return {
        text: JSON.stringify({
          rewrittenQuestion: 'default',
          needsClarification: false,
          clarificationQuestions: [],
          route: 'retrieve',
        }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      };
    });
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('persists an interrupt checkpoint scoped by org and threadId', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        rewrittenQuestion: 'Need env?',
        needsClarification: true,
        clarificationQuestions: [{ type: 'free_text', prompt: 'Which environment?' }],
        route: 'retrieve',
      }),
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: null },
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);
    const checkpointer = createMongoChatCheckpointer();
    const compiled = compileChatGraph({ checkpointer });
    const interrupted = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'How do I deploy?' },
    });
    expect(interrupted.__interrupt__).toBeDefined();
    const rows = await ChatCheckpoint.find({ orgId, threadId }).lean();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => String(row.orgId) === String(orgId))).toBe(true);
    expect(rows[0].checkpoint).toEqual(
      expect.objectContaining({
        type: expect.any(String),
        data: expect.any(String),
      }),
    );
  });

  it('resumes from Mongo with clarification answers bound into state', async () => {
    const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);
    mockGenerateText
      .mockResolvedValueOnce({
        text: JSON.stringify({
          rewrittenQuestion: 'Need env?',
          needsClarification: true,
          clarificationQuestions: [{ type: 'free_text', prompt: 'Which environment?' }],
          route: 'retrieve',
        }),
        usage: null,
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          rewrittenQuestion: 'How do I deploy to staging?',
          needsClarification: false,
          clarificationQuestions: [],
          route: 'retrieve',
        }),
        usage: null,
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      });
    const checkpointer = createMongoChatCheckpointer();
    const compiled = compileChatGraph({ checkpointer });
    const interrupted = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'deploy?' },
    });
    const clarificationSet = interrupted.__interrupt__[0].value;
    const resumed = await resumeChatGraphFromClarification({
      threadId,
      compiled,
      checkpointer,
      clarificationSetId: clarificationSet.clarificationSetId,
      answers: { q1: 'staging' },
    });
    expect(resumed.clarificationAnswers).toEqual({ q1: 'staging' });
    expect(resumed.route).toBe('retrieve');
    expect(resumed.retrievalComplete).toBe(true);
    expect(resumed.rewrittenQuestion).toContain('staging');
  });

  it('runs UNDERSTAND retrieve through AGENT_TOOLS with two evidence batches', async () => {
    const threadId = buildChatGraphThreadId(orgId, conversationId, `${assistantMessageId}-tools`);
    mockGenerateText
      .mockResolvedValueOnce({
        text: JSON.stringify({
          rewrittenQuestion: 'How does login work?',
          needsClarification: false,
          clarificationQuestions: [],
          route: 'retrieve',
        }),
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          action: 'call_tool',
          toolName: 'explore_code',
          toolArgs: { query: 'login' },
        }),
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          action: 'call_tool',
          toolName: 'search_documents',
          toolArgs: { query: 'auth' },
        }),
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ action: 'finish_retrieval' }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      });
    mockExecuteTool
      .mockResolvedValueOnce({
        evidenceRecords: [{ evidenceId: 'ev_01', path: 'src/a.js', kind: 'code', excerpt: 'a' }],
        rejected: [],
        usage: { resultBytes: 4, promptTokensAfterBudget: 1 },
      })
      .mockResolvedValueOnce({
        evidenceRecords: [{ evidenceId: 'ev_02', path: 'docs/b.md', kind: 'document', excerpt: 'b' }],
        rejected: [],
        usage: { resultBytes: 4, promptTokensAfterBudget: 1 },
      });
    const checkpointer = createMongoChatCheckpointer();
    const compiled = compileChatGraph({ checkpointer });
    const result = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: {
        scope: {
          ...scope(),
          assistantMessageId: `${assistantMessageId}-tools`,
        },
        question: 'How does login work?',
      },
    });
    expect(result.toolResults).toHaveLength(2);
    expect(result.retrievalComplete).toBe(true);
    expect(result.cumulativeToolResultBytes).toBe(8);
  });

  it('persists a completed assistant message with evidence after draft verify', async () => {
    const projectId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const knowledgeVersionId = new mongoose.Types.ObjectId();
    const pendingAssistantId = new mongoose.Types.ObjectId();
    const threadId = buildChatGraphThreadId(orgId, conversationId, pendingAssistantId);

    await Conversation.create({
      orgId,
      projectId,
      ownerUserId: userId,
      title: 'Persist test',
      titleSource: 'default',
      searchText: '',
      lifecycleStatus: 'active',
      messageCount: 1,
      createdBy: userId,
      updatedBy: userId,
    });
    await Message.create({
      _id: pendingAssistantId,
      orgId,
      projectId,
      conversationId,
      role: 'assistant',
      content: '(pending)',
      messageStatus: 'completed',
      createdBy: userId,
      updatedBy: userId,
    });

    mockGenerateText
      .mockResolvedValueOnce({
        text: JSON.stringify({
          rewrittenQuestion: 'How does login work?',
          needsClarification: false,
          clarificationQuestions: [],
          route: 'retrieve',
        }),
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          action: 'call_tool',
          toolName: 'explore_code',
          toolArgs: { query: 'login' },
        }),
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ action: 'finish_retrieval' }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      });
    mockExecuteTool.mockResolvedValueOnce({
      evidenceRecords: [
        {
          evidenceId: 'ev_01',
          path: 'src/a.js',
          kind: 'code',
          excerpt: 'jwt',
          knowledgeVersionId: String(knowledgeVersionId),
        },
      ],
      rejected: [],
      usage: { resultBytes: 4, promptTokensAfterBudget: 1 },
    });

    const checkpointer = createMongoChatCheckpointer();
    const compiled = compileChatGraph({ checkpointer });
    const result = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: {
        scope: {
          ...scope(),
          projectId: String(projectId),
          userId: String(userId),
          assistantMessageId: String(pendingAssistantId),
          knowledgeVersionId: String(knowledgeVersionId),
        },
        question: 'How does login work?',
      },
    });

    expect(result.supportLevel).toBe('evidence_backed');
    expect(result.persistFailed).toBe(false);
    const stored = await Message.findById(pendingAssistantId).lean();
    expect(stored.messageStatus).toBe('completed');
    expect(stored.supportLevel).toBe('evidence_backed');
    expect(stored.content).toContain('ev_01');
    expect(Array.isArray(stored.evidence)).toBe(true);
    expect(stored.evidence[0].evidenceId).toBe('ev_01');
    expect(stored.trace?.evidenceIds).toEqual(['ev_01']);
    expect(stored.modelId).toBe('test-model');
  });

  it('persists a completed converse reply with null supportLevel and no evidence', async () => {
    const projectId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const pendingAssistantId = new mongoose.Types.ObjectId();
    const threadId = buildChatGraphThreadId(orgId, conversationId, pendingAssistantId);

    await Conversation.create({
      orgId,
      projectId,
      ownerUserId: userId,
      title: 'Converse test',
      titleSource: 'default',
      searchText: '',
      lifecycleStatus: 'active',
      messageCount: 1,
      createdBy: userId,
      updatedBy: userId,
    });
    await Message.create({
      _id: pendingAssistantId,
      orgId,
      projectId,
      conversationId,
      role: 'assistant',
      content: '(pending)',
      messageStatus: 'generating',
      createdBy: userId,
      updatedBy: userId,
    });

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        rewrittenQuestion: 'hi',
        needsClarification: false,
        clarificationQuestions: [],
        route: 'converse',
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: null },
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    mockStreamText.mockResolvedValue({
      textStream: (async function* streamChunks() {
        yield 'Hello — ask about Payments API.';
      })(),
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 4, totalTokens: null }),
      durationMs: Promise.resolve(5),
      modelId: 'test-model',
      contextMetrics: { measuredInputTokens: 2 },
      enableThinking: false,
    });

    const checkpointer = createMongoChatCheckpointer();
    const compiled = compileChatGraph({ checkpointer });
    await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: {
        scope: {
          ...scope(),
          projectId: String(projectId),
          userId: String(userId),
          assistantMessageId: String(pendingAssistantId),
        },
        question: 'hi',
      },
    });

    const stored = await Message.findById(pendingAssistantId).lean();
    expect(stored.messageStatus).toBe('completed');
    expect(stored.supportLevel).toBeNull();
    expect(stored.evidence).toBeNull();
    expect(stored.content).toContain('Hello');
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('persists abstained status when retrieval finishes with empty evidence', async () => {
    const projectId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const pendingAssistantId = new mongoose.Types.ObjectId();
    const threadId = buildChatGraphThreadId(orgId, conversationId, pendingAssistantId);

    await Conversation.create({
      orgId,
      projectId,
      ownerUserId: userId,
      title: 'Abstain test',
      titleSource: 'default',
      searchText: '',
      lifecycleStatus: 'active',
      messageCount: 1,
      createdBy: userId,
      updatedBy: userId,
    });
    await Message.create({
      _id: pendingAssistantId,
      orgId,
      projectId,
      conversationId,
      role: 'assistant',
      content: '(pending)',
      messageStatus: 'completed',
      createdBy: userId,
      updatedBy: userId,
    });

    const checkpointer = createMongoChatCheckpointer();
    const compiled = compileChatGraph({ checkpointer });
    await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: {
        scope: {
          ...scope(),
          projectId: String(projectId),
          userId: String(userId),
          assistantMessageId: String(pendingAssistantId),
        },
        question: 'How does login work?',
      },
    });

    const stored = await Message.findById(pendingAssistantId).lean();
    expect(stored.messageStatus).toBe('abstained');
    expect(stored.supportLevel).toBe('insufficient');
    expect(stored.evidence).toBeNull();
  });

  it('fails closed when configurable org_id does not match the thread org', async () => {
    const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);
    const checkpointer = createMongoChatCheckpointer();
    await ChatCheckpoint.create({
      orgId,
      threadId,
      checkpointNs: '',
      checkpointId: 'cp-1',
      parentCheckpointId: null,
      checkpoint: { type: 'json', data: Buffer.from('{}').toString('base64') },
      metadata: {
        langGraph: { type: 'json', data: Buffer.from('{}').toString('base64') },
        product: {},
      },
    });
    const tuple = await checkpointer.getTuple({
      configurable: {
        thread_id: threadId,
        org_id: String(otherOrgId),
        checkpoint_id: 'cp-1',
      },
    });
    expect(tuple).toBeUndefined();
  });

  it('lists checkpoints, soft-deletes a thread, and no-ops putWrites when missing', async () => {
    const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);
    const checkpointer = createMongoChatCheckpointer();
    await checkpointer.put(
      { configurable: { thread_id: threadId, org_id: String(orgId), checkpoint_ns: '' } },
      {
        v: 4,
        id: 'list-cp-1',
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'input', step: -1, parents: {} },
    );
    const listed = [];
    for await (const tuple of checkpointer.list({
      configurable: { thread_id: threadId, org_id: String(orgId) },
    })) {
      listed.push(tuple);
    }
    expect(listed.length).toBeGreaterThan(0);
    await checkpointer.putWrites(
      {
        configurable: {
          thread_id: threadId,
          org_id: String(orgId),
          checkpoint_ns: '',
          checkpoint_id: 'missing-cp',
        },
      },
      [['channel', 'value']],
      'task-1',
    );
    await checkpointer.deleteThread(threadId);
    const active = await ChatCheckpoint.find({ orgId, threadId, status: 'A' }).lean();
    expect(active).toHaveLength(0);
    const deleted = await ChatCheckpoint.find({ orgId, threadId, status: 'D' }).lean();
    expect(deleted.length).toBeGreaterThan(0);
  });

  it('throws when put is called with a mismatched org_id', async () => {
    const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);
    const checkpointer = createMongoChatCheckpointer();
    await expect(
      checkpointer.put(
        { configurable: { thread_id: threadId, org_id: String(otherOrgId) } },
        {
          v: 4,
          id: 'bad-org',
          ts: new Date().toISOString(),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'input', step: -1, parents: {} },
      ),
    ).rejects.toThrow(/org scope mismatch/);
  });

  it('covers checkpointer edge paths for missing keys, writes, and invalid threads', async () => {
    const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);
    const checkpointer = createMongoChatCheckpointer();
    expect(await checkpointer.getTuple({})).toBeUndefined();
    const emptyList = [];
    for await (const row of checkpointer.list({})) {
      emptyList.push(row);
    }
    expect(emptyList).toEqual([]);
    await expect(checkpointer.put({}, { id: 'x', v: 4, ts: '', channel_values: {}, channel_versions: {}, versions_seen: {} }, {})).rejects.toThrow(
      /missing thread_id/,
    );
    await expect(checkpointer.putWrites({ configurable: { thread_id: threadId, org_id: String(orgId) } }, [['c', 1]], 't1')).rejects.toThrow(
      /missing thread_id or checkpoint_id/,
    );
    await expect(
      checkpointer.putWrites(
        {
          configurable: {
            thread_id: threadId,
            org_id: String(otherOrgId),
            checkpoint_id: 'cp',
          },
        },
        [['c', 1]],
        't1',
      ),
    ).rejects.toThrow(/org scope mismatch/);

    await checkpointer.put(
      { configurable: { thread_id: threadId, org_id: String(orgId), checkpoint_ns: '' } },
      {
        v: 4,
        id: 'writes-cp',
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'input', step: -1, parents: {} },
    );
    await checkpointer.putWrites(
      {
        configurable: {
          thread_id: threadId,
          org_id: String(orgId),
          checkpoint_ns: '',
          checkpoint_id: 'writes-cp',
        },
      },
      [['channel_a', { ok: true }]],
      'task-a',
      'path',
    );
    const tuple = await checkpointer.getTuple({
      configurable: {
        thread_id: threadId,
        org_id: String(orgId),
        checkpoint_id: 'writes-cp',
      },
    });
    expect(tuple?.pendingWrites?.length).toBeGreaterThan(0);
    await checkpointer.deleteThread('not-an-objectid:conv:asst');

    await checkpointer.put(
      { configurable: { thread_id: threadId, org_id: String(orgId), checkpoint_ns: '' } },
      {
        v: 4,
        id: 'list-cp-2',
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'loop', step: 1, parents: {} },
    );
    const limited = [];
    for await (const tuple of checkpointer.list(
      { configurable: { thread_id: threadId, org_id: String(orgId) } },
      {
        limit: 1,
        before: { configurable: { checkpoint_id: 'list-cp-2' } },
      },
    )) {
      limited.push(tuple);
    }
    expect(limited.length).toBeLessThanOrEqual(1);

    const badScope = await checkpointer.getTuple({
      configurable: { thread_id: 'not-an-objectid:conv:asst', org_id: 'not-an-objectid' },
    });
    expect(badScope).toBeUndefined();

    const malformed = await checkpointer.getTuple({
      configurable: { thread_id: 'only-one-part', org_id: String(orgId) },
    });
    expect(malformed).toBeUndefined();

    const listWrongOrg = [];
    for await (const tuple of checkpointer.list({
      configurable: { thread_id: threadId, org_id: String(otherOrgId) },
    })) {
      listWrongOrg.push(tuple);
    }
    expect(listWrongOrg).toEqual([]);
  });
});
