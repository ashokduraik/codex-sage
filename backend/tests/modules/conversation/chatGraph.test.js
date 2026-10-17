/**
 * Unit tests for Phase 47 chat graph: UNDERSTAND routing, clarify interrupt,
 * enableThinking=false, hooks, and fail-closed repair / budget paths.
 */
import mongoose from 'mongoose';
import { MemorySaver } from '@langchain/langgraph';
import { ApiError } from '../../../src/platform/errors.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invokeChatGraph,
  compileChatGraph,
  buildChatGraphThreadId,
  parseChatGraphThreadId,
  CLARIFICATION_MAX_ROUNDS,
  understandDecisionSchema,
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

const orgId = new mongoose.Types.ObjectId().toString();
const conversationId = new mongoose.Types.ObjectId().toString();
const assistantMessageId = new mongoose.Types.ObjectId().toString();
const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);

/**
 * @param {object} [overrides] Decision field overrides.
 * @returns {object}
 */
function decision(overrides = {}) {
  return {
    rewrittenQuestion: 'How does login work in this project?',
    needsClarification: false,
    clarificationQuestions: [],
    route: 'retrieve',
    ...overrides,
  };
}

/**
 * @param {object} [overrides] Scope overrides.
 * @returns {object}
 */
function scope(overrides = {}) {
  return {
    orgId,
    projectId: new mongoose.Types.ObjectId().toString(),
    userId: new mongoose.Types.ObjectId().toString(),
    conversationId,
    userMessageId: new mongoose.Types.ObjectId().toString(),
    assistantMessageId,
    knowledgeVersionId: new mongoose.Types.ObjectId().toString(),
    correlationId: 'corr-1',
    ...overrides,
  };
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockBuildConversationContext.mockReset();
  mockBuildConversationContext.mockResolvedValue({
    segments: [{ id: 'turn:1', kind: 'turn', role: 'user', content: 'prior' }],
    summarySegment: undefined,
    pinnedSegments: [],
    recentMessageIds: [],
  });
  mockGenerateText.mockResolvedValue({
    text: JSON.stringify(decision()),
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: null },
    durationMs: 1,
    modelId: 'test-model',
    contextMetrics: { measuredInputTokens: 10, compactionActions: [] },
    enableThinking: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('understandDecisionSchema', () => {
  it('rejects an invalid route and missing rewrittenQuestion', () => {
    expect(
      understandDecisionSchema.safeParse({
        rewrittenQuestion: '',
        needsClarification: false,
        clarificationQuestions: [],
        route: 'clarify',
      }).success,
    ).toBe(false);
    expect(
      understandDecisionSchema.safeParse({
        needsClarification: false,
        clarificationQuestions: [],
        route: 'retrieve',
      }).success,
    ).toBe(false);
  });

  it('accepts retrieve and abstain_early with typed questions', () => {
    expect(
      understandDecisionSchema.safeParse(
        decision({
          needsClarification: true,
          clarificationQuestions: [{ type: 'free_text', prompt: 'Which env?' }],
          route: 'retrieve',
        }),
      ).success,
    ).toBe(true);
    expect(understandDecisionSchema.safeParse(decision({ route: 'abstain_early' })).success).toBe(true);
  });
});

describe('thread id helpers', () => {
  it('builds and parses the org/conversation/assistant composite', () => {
    expect(threadId).toBe(`${orgId}:${conversationId}:${assistantMessageId}`);
    expect(parseChatGraphThreadId(threadId)).toEqual({
      orgId,
      conversationId,
      assistantMessageId,
    });
    expect(() => parseChatGraphThreadId('bad')).toThrow(/invalid chat graph threadId/);
  });
});

describe('invokeChatGraph', () => {
  it('runs UNDERSTAND with enableThinking false and ends on retrieve', async () => {
    const stages = [];
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({
      checkpointer,
      onStage: (event) => stages.push(event),
    });
    const result = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'How does login work?' },
    });
    expect(result.route).toBe('retrieve');
    expect(result.rewrittenQuestion).toContain('login');
    expect(result.__interrupt__).toBeUndefined();
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'understand',
        enableThinking: false,
      }),
    );
    expect(stages).toEqual([expect.objectContaining({ stage: 'understanding_question' })]);
  });

  it('interrupts on needsClarification and resumes into UNDERSTAND with answers', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: JSON.stringify(
          decision({
            needsClarification: true,
            clarificationQuestions: [{ type: 'single_select', prompt: 'Which auth?', options: ['JWT', 'session'] }],
            route: 'retrieve',
          }),
        ),
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(decision({ rewrittenQuestion: 'How does JWT login work?' })),
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      });

    const stages = [];
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({
      checkpointer,
      onStage: (event) => stages.push(event.stage),
    });
    const interrupted = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'How does login work?' },
    });
    expect(interrupted.__interrupt__).toBeDefined();
    const clarificationSet = interrupted.__interrupt__[0].value;
    expect(clarificationSet.questions[0].id).toBe('q1');
    expect(stages).toContain('awaiting_clarification');

    const resumed = await resumeChatGraphFromClarification({
      threadId,
      compiled,
      checkpointer,
      clarificationSetId: clarificationSet.clarificationSetId,
      answers: { q1: 'JWT' },
    });
    expect(resumed.clarificationAnswers).toEqual({ q1: 'JWT' });
    expect(resumed.route).toBe('retrieve');
    expect(resumed.rewrittenQuestion).toContain('JWT');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockGenerateText.mock.calls.every((call) => call[0].enableThinking === false)).toBe(true);
  });

  it('routes abstain_early and fires the abstain stage hook', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(decision({ route: 'abstain_early', rewrittenQuestion: 'unclear' })),
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const stages = [];
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({
      checkpointer,
      onStage: (event) => stages.push(event.stage),
    });
    const result = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: { scope: scope(), question: '???' },
    });
    expect(result.route).toBe('abstain_early');
    expect(stages).toEqual(['understanding_question', 'abstain_early']);
  });

  it('does not call the LLM when context accounting is unavailable', async () => {
    mockGenerateText.mockRejectedValue(ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE'));
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    await expect(
      invokeChatGraph({
        threadId,
        compiled,
        checkpointer,
        input: { scope: scope(), question: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_ACCOUNTING_UNAVAILABLE' });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('abstains after two invalid UNDERSTAND JSON payloads', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{not-json',
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    const result = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'x' },
    });
    expect(result.route).toBe('abstain_early');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('abstains when the UNDERSTAND repair call fails with a non-accounting error', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: '{bad',
        usage: null,
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockRejectedValueOnce(new Error('repair provider down'));
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    const result = await invokeChatGraph({
      threadId: `${threadId}-repair-fail`,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'x' },
    });
    expect(result.route).toBe('abstain_early');
  });

  it('rethrows CONTEXT_ACCOUNTING_UNAVAILABLE from the UNDERSTAND repair call', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: '{bad',
        usage: null,
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockRejectedValueOnce(ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE'));
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-repair-acct`,
        compiled,
        checkpointer,
        input: { scope: scope(), question: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_ACCOUNTING_UNAVAILABLE' });
  });

  it('normalises clarification question options on interrupt', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(
        decision({
          needsClarification: true,
          clarificationQuestions: [
            { id: 'custom', type: 'multi_select', prompt: 'Pick', options: ['a', 'b'] },
            { type: 'free_text', prompt: 'Also?' },
          ],
          route: 'retrieve',
        }),
      ),
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    const interrupted = await invokeChatGraph({
      threadId: `${threadId}-opts`,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(interrupted.__interrupt__[0].value.questions[0]).toEqual({
      id: 'custom',
      type: 'multi_select',
      prompt: 'Pick',
      options: ['a', 'b'],
    });
    expect(interrupted.__interrupt__[0].value.questions[1].id).toBe('q2');
  });

  it('treats empty or non-string UNDERSTAND text as invalid and abstains after repair', async () => {
    mockGenerateText.mockResolvedValue({
      text: '',
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-empty-text`,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(result.route).toBe('abstain_early');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('compiles with default onStage when none is provided', async () => {
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-default-hook`,
      checkpointer,
      input: { scope: scope(), question: 'How does login work?' },
    });
    expect(result.route).toBe('retrieve');
  });

  it('keeps the checkpoint path working when the stage hook throws', async () => {
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({
      checkpointer,
      onStage: () => {
        throw new Error('hook boom');
      },
    });
    const result = await invokeChatGraph({
      threadId,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'How does login work?' },
    });
    expect(result.route).toBe('retrieve');
  });

  it('repairs once when the first UNDERSTAND payload is invalid then succeeds', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: '{bad',
        usage: null,
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(decision({ rewrittenQuestion: 'repaired question' })),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: null },
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      });
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    const result = await invokeChatGraph({
      threadId: `${threadId}-repair`,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(result.rewrittenQuestion).toBe('repaired question');
    expect(result.route).toBe('retrieve');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('maps unexpected LLM failures to LLM_PROVIDER_ERROR', async () => {
    mockGenerateText.mockRejectedValue(new Error('socket hang up'));
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-llmerr`,
        compiled,
        checkpointer,
        input: { scope: scope(), question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
  });

  it('rejects an incomplete scope before calling the LLM', async () => {
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-scope`,
        compiled,
        checkpointer,
        input: { scope: { orgId }, question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('abstains when resumed clarificationSetId does not match the interrupt set', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(
        decision({
          needsClarification: true,
          clarificationQuestions: [{ type: 'free_text', prompt: 'Which?' }],
          route: 'retrieve',
        }),
      ),
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    const interrupted = await invokeChatGraph({
      threadId: `${threadId}-mismatch`,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    const set = interrupted.__interrupt__[0].value;
    const resumed = await resumeChatGraphFromClarification({
      threadId: `${threadId}-mismatch`,
      compiled,
      checkpointer,
      clarificationSetId: 'not-the-set-id',
      answers: { q1: 'x' },
    });
    expect(set.clarificationSetId).not.toBe('not-the-set-id');
    expect(resumed.route).toBe('abstain_early');
    expect(resumed.clarificationAnswers).toBeNull();
  });

  it('forces abstain when clarify rounds are already exhausted', async () => {
    expect(CLARIFICATION_MAX_ROUNDS).toBe(2);
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(
        decision({
          needsClarification: true,
          clarificationQuestions: [{ type: 'free_text', prompt: 'More?' }],
          route: 'retrieve',
        }),
      ),
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({ checkpointer });
    // Seed a checkpointed state by interrupting once, resuming with answers that
    // still need clarify, then interrupting again, then answering again into abstain.
    const first = await invokeChatGraph({
      threadId: `${threadId}-rounds`,
      compiled,
      checkpointer,
      input: { scope: scope({ assistantMessageId: `${assistantMessageId}r` }), question: 'q' },
    });
    const set1 = first.__interrupt__[0].value;
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(
        decision({
          needsClarification: true,
          clarificationQuestions: [{ type: 'free_text', prompt: 'Still more?' }],
          route: 'retrieve',
        }),
      ),
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const second = await resumeChatGraphFromClarification({
      threadId: `${threadId}-rounds`,
      compiled,
      checkpointer,
      clarificationSetId: set1.clarificationSetId,
      answers: { q1: 'a' },
    });
    const set2 = second.__interrupt__[0].value;
    expect(set2.roundIndex).toBe(1);
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(
        decision({
          needsClarification: true,
          clarificationQuestions: [{ type: 'free_text', prompt: 'Third?' }],
          route: 'retrieve',
        }),
      ),
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const third = await resumeChatGraphFromClarification({
      threadId: `${threadId}-rounds`,
      compiled,
      checkpointer,
      clarificationSetId: set2.clarificationSetId,
      answers: { q1: 'b' },
    });
    expect(third.__interrupt__).toBeUndefined();
    expect(third.route).toBe('abstain_early');
  });
});
