/**
 * Mongo integration tests for chatCheckpoints checkpointer and clarify resume.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { ChatCheckpoint } from '../../../src/models/chatCheckpoint.model.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invokeChatGraph,
  compileChatGraph,
  buildChatGraphThreadId,
  createMongoChatCheckpointer,
  resumeChatGraphFromClarification,
} from '../../../src/modules/conversation/chatGraph.js';

const { mockGenerateText, mockBuildConversationContext } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockBuildConversationContext: vi.fn(),
}));

vi.mock('../../../src/modules/conversation/llm.js', () => ({
  generateText: (...args) => mockGenerateText(...args),
  streamText: vi.fn(),
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

const harness = createMongoHarness({
  models: [ChatCheckpoint],
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
  };
}

describe('chatGraph Mongo checkpointer', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildConversationContext.mockResolvedValue({
      segments: [],
      summarySegment: undefined,
      pinnedSegments: [],
      recentMessageIds: [],
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
    expect(resumed.rewrittenQuestion).toContain('staging');
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
