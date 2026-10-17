/**
 * Unit tests for chat graph: UNDERSTAND routing, AGENT_TOOLS loop, clarify
 * interrupt, enableThinking=false, hooks, and fail-closed repair / budget paths.
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
  toolChoiceDecisionSchema,
  understandDecisionSchema,
  resumeChatGraphFromClarification,
} from '../../../src/modules/conversation/chatGraph.js';

const { mockGenerateText, mockBuildConversationContext, mockExecuteTool, mockGetRunBudgetConfig } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockBuildConversationContext: vi.fn(),
  mockExecuteTool: vi.fn(),
  mockGetRunBudgetConfig: vi.fn(),
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
 * @param {object} [overrides] Tool-choice overrides.
 * @returns {object}
 */
function toolChoice(overrides = {}) {
  return {
    action: 'finish_retrieval',
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
    workspaceRoot: '/tmp/codex-sage-workspace',
    budgetState: {
      modelArtifactRef: 'test-model',
      options: {
        validatedContextCapacity: 10_000,
        reservedOutputTokens: 0,
        llm: { contextCapacity: 10_000, artifactId: 'test-model' },
      },
    },
    ...overrides,
  };
}

/**
 * @param {object} body Structured model JSON.
 * @param {object} [usage] Token usage.
 * @returns {object}
 */
function llmResult(body, usage = { inputTokens: 10, outputTokens: 4, totalTokens: null }) {
  return {
    text: JSON.stringify(body),
    usage,
    durationMs: 1,
    modelId: 'test-model',
    contextMetrics: { measuredInputTokens: 10, compactionActions: [] },
    enableThinking: false,
  };
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockBuildConversationContext.mockReset();
  mockExecuteTool.mockReset();
  mockGetRunBudgetConfig.mockReset();
  mockGetRunBudgetConfig.mockReturnValue({
    maxCumulativeInputTokens: null,
    maxCumulativeOutputTokens: null,
    maxCumulativeToolResultBytes: null,
    maxTotalCalls: null,
    maxWallTimeMs: null,
  });
  mockBuildConversationContext.mockResolvedValue({
    segments: [{ id: 'turn:1', kind: 'turn', role: 'user', content: 'prior' }],
    summarySegment: undefined,
    pinnedSegments: [],
    recentMessageIds: [],
  });
  mockGenerateText.mockImplementation(async (request) => {
    if (request.purpose === 'tool_choice') {
      return llmResult(toolChoice(), { inputTokens: 2, outputTokens: 1, totalTokens: null });
    }
    return llmResult(decision());
  });
  mockExecuteTool.mockResolvedValue({
    evidenceRecords: [],
    rejected: [],
    usage: { resultBytes: 0, promptTokensAfterBudget: 0 },
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

describe('toolChoiceDecisionSchema', () => {
  it('requires toolName when action is call_tool', () => {
    expect(toolChoiceDecisionSchema.safeParse({ action: 'call_tool' }).success).toBe(false);
    expect(
      toolChoiceDecisionSchema.safeParse({
        action: 'call_tool',
        toolName: 'explore_code',
        toolArgs: { query: 'login' },
      }).success,
    ).toBe(true);
    expect(toolChoiceDecisionSchema.safeParse({ action: 'finish_retrieval' }).success).toBe(true);
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
  it('runs UNDERSTAND with enableThinking false then finishes retrieval', async () => {
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
    expect(result.retrievalComplete).toBe(true);
    expect(result.rewrittenQuestion).toContain('login');
    expect(result.__interrupt__).toBeUndefined();
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'understand',
        enableThinking: false,
      }),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'tool_choice',
        enableThinking: false,
      }),
    );
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(stages).toEqual([expect.objectContaining({ stage: 'understanding_question' })]);
  });

  it('interrupts on needsClarification and resumes into UNDERSTAND with answers', async () => {
    mockGenerateText
      .mockResolvedValueOnce(
        llmResult(
          decision({
            needsClarification: true,
            clarificationQuestions: [{ type: 'single_select', prompt: 'Which auth?', options: ['JWT', 'session'] }],
            route: 'retrieve',
          }),
          { inputTokens: 3, outputTokens: 2, totalTokens: null },
        ),
      )
      .mockResolvedValueOnce(
        llmResult(decision({ rewrittenQuestion: 'How does JWT login work?' }), {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: null,
        }),
      );

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
    expect(resumed.retrievalComplete).toBe(true);
    expect(resumed.rewrittenQuestion).toContain('JWT');
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
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
    expect(result.retrievalComplete).toBe(true);
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
    expect(result.retrievalComplete).toBe(true);
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
      .mockResolvedValueOnce(
        llmResult(decision({ rewrittenQuestion: 'repaired question' }), {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: null,
        }),
      );
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
    expect(result.retrievalComplete).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
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

describe('AGENT_TOOLS loop', () => {
  it('exits on finish_retrieval without executing tools', async () => {
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-finish`,
      checkpointer,
      input: { scope: scope(), question: 'How does login work?' },
    });
    expect(result.retrievalComplete).toBe(true);
    expect(result.toolResults).toEqual([]);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('runs two tool iterations then finishes with evidence batches', async () => {
    mockGenerateText
      .mockResolvedValueOnce(llmResult(decision()))
      .mockResolvedValueOnce(
        llmResult({
          action: 'call_tool',
          toolName: 'explore_code',
          toolArgs: { query: 'login' },
        }),
      )
      .mockResolvedValueOnce(
        llmResult({
          action: 'call_tool',
          toolName: 'search_documents',
          toolArgs: { query: 'auth' },
        }),
      )
      .mockResolvedValueOnce(llmResult(toolChoice()));
    mockExecuteTool
      .mockResolvedValueOnce({
        evidenceRecords: [{ evidenceId: 'ev_01', path: 'src/a.js', kind: 'code', excerpt: 'a' }],
        rejected: [],
        usage: { resultBytes: 10, promptTokensAfterBudget: 3 },
      })
      .mockResolvedValueOnce({
        evidenceRecords: [{ evidenceId: 'ev_02', path: 'docs/b.md', kind: 'document', excerpt: 'b' }],
        rejected: [],
        usage: { resultBytes: 12, promptTokensAfterBudget: 4 },
      });

    const stages = [];
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({
      checkpointer,
      onStage: (event) => stages.push(event.stage),
    });
    const result = await invokeChatGraph({
      threadId: `${threadId}-two-tools`,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'How does login work?' },
    });
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults.map((record) => record.evidenceId)).toEqual(['ev_01', 'ev_02']);
    expect(result.cumulativeToolResultBytes).toBe(22);
    expect(result.totalCalls).toBe(5);
    expect(result.retrievalComplete).toBe(true);
    expect(stages).toEqual(['understanding_question', 'searching_code', 'reviewing_sources']);
    expect(mockExecuteTool).toHaveBeenCalledTimes(2);
  });

  it('sets budgetExhausted when totalCalls limit is exceeded', async () => {
    mockGetRunBudgetConfig.mockReturnValue({
      maxCumulativeInputTokens: null,
      maxCumulativeOutputTokens: null,
      maxCumulativeToolResultBytes: null,
      maxTotalCalls: 1,
      maxWallTimeMs: null,
    });
    // After the first tool-choice model call, totalCalls becomes 1 and blocks executeTool.
    mockGenerateText.mockResolvedValueOnce(llmResult(decision(), { inputTokens: 1, outputTokens: 1, totalTokens: null })).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'search_documents',
        toolArgs: { query: 'x' },
      }),
    );
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-budget`,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(result.budgetExhausted).toBe(true);
    expect(result.totalCalls).toBe(1);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('keeps partial toolResults when abortSignal trips between iterations', async () => {
    const controller = new AbortController();
    mockGenerateText
      .mockResolvedValueOnce(llmResult(decision()))
      .mockResolvedValueOnce(
        llmResult({
          action: 'call_tool',
          toolName: 'explore_code',
          toolArgs: { query: 'login' },
        }),
      )
      .mockImplementationOnce(async () => {
        controller.abort();
        return llmResult({
          action: 'call_tool',
          toolName: 'search_documents',
          toolArgs: { query: 'x' },
        });
      });
    mockExecuteTool.mockResolvedValueOnce({
      evidenceRecords: [{ evidenceId: 'ev_01', path: 'src/a.js', kind: 'code', excerpt: 'a' }],
      rejected: [],
      usage: { resultBytes: 8, promptTokensAfterBudget: 2 },
    });
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-abort`,
      checkpointer,
      input: { scope: scope({ abortSignal: controller.signal }), question: 'q' },
    });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].evidenceId).toBe('ev_01');
    expect(result.retrievalComplete).toBe(true);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });

  it('sets toolStop when the abstain tool returns stop', async () => {
    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'abstain',
        toolArgs: { reasonCode: 'insufficient_scope', message: 'Not enough evidence.' },
      }),
    );
    mockExecuteTool.mockResolvedValueOnce({
      evidenceRecords: [],
      rejected: [],
      usage: { resultBytes: 0, promptTokensAfterBudget: 0 },
      stop: { reasonCode: 'insufficient_scope', message: 'Not enough evidence.' },
    });
    const stages = [];
    const checkpointer = new MemorySaver();
    const compiled = compileChatGraph({
      checkpointer,
      onStage: (event) => stages.push(event.stage),
    });
    const result = await invokeChatGraph({
      threadId: `${threadId}-abstain-tool`,
      compiled,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(result.toolStop).toEqual({
      reasonCode: 'insufficient_scope',
      message: 'Not enough evidence.',
    });
    expect(result.retrievalComplete).toBe(true);
    expect(stages).toEqual(['understanding_question']);
  });

  it('rethrows KNOWLEDGE_UNAVAILABLE from explore_code', async () => {
    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'explore_code',
        toolArgs: { query: 'login' },
      }),
    );
    mockExecuteTool.mockRejectedValueOnce(ApiError.fromCode('KNOWLEDGE_UNAVAILABLE'));
    const checkpointer = new MemorySaver();
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-knowledge`,
        checkpointer,
        input: { scope: scope(), question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('rethrows TOOL_UNKNOWN from executeTool', async () => {
    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'explore_code',
        toolArgs: { query: 'x' },
      }),
    );
    mockExecuteTool.mockRejectedValueOnce(ApiError.fromCode('TOOL_UNKNOWN'));
    const checkpointer = new MemorySaver();
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-unknown`,
        checkpointer,
        input: { scope: scope(), question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'TOOL_UNKNOWN' });
  });

  it('repairs invalid tool-choice JSON then finishes retrieval', async () => {
    mockGenerateText
      .mockResolvedValueOnce(llmResult(decision()))
      .mockResolvedValueOnce({
        text: '{bad-tool-choice',
        usage: null,
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockResolvedValueOnce(llmResult(toolChoice()));
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-tool-repair`,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(result.retrievalComplete).toBe(true);
    expect(mockGenerateText.mock.calls.filter((call) => call[0].purpose === 'tool_choice')).toHaveLength(2);
  });

  it('marks retrieval complete when tool-choice stays invalid after repair', async () => {
    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValue({
      text: '{still-bad',
      usage: null,
      durationMs: 1,
      modelId: 'test-model',
      contextMetrics: {},
      enableThinking: false,
    });
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-tool-invalid`,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(result.retrievalComplete).toBe(true);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('rejects missing tool workspace or budgetState before executeTool', async () => {
    const checkpointer = new MemorySaver();
    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'read_file_slice',
        toolArgs: { path: 'a.js', startLine: 1, endLine: 2 },
      }),
    );
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-scope-incomplete`,
        checkpointer,
        input: {
          scope: scope({ workspaceRoot: undefined }),
          question: 'q',
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'chat_graph_tool_scope_incomplete' } });

    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'read_file_slice',
        toolArgs: { path: 'a.js', startLine: 1, endLine: 2 },
      }),
    );
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-budget-missing`,
        checkpointer,
        input: {
          scope: scope({ budgetState: undefined }),
          question: 'q',
        },
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'chat_graph_tool_budget_state_missing' },
    });
  });

  it('ends cleanly when abortSignal is already aborted at AGENT_TOOLS entry', async () => {
    const controller = new AbortController();
    controller.abort();
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-preabort`,
      checkpointer,
      input: { scope: scope({ abortSignal: controller.signal }), question: 'q' },
    });
    expect(result.retrievalComplete).toBe(true);
    expect(mockGenerateText.mock.calls.some((call) => call[0].purpose === 'tool_choice')).toBe(false);
  });

  it('rethrows CONTEXT_ACCOUNTING_UNAVAILABLE from tool-choice repair', async () => {
    mockGenerateText
      .mockResolvedValueOnce(llmResult(decision()))
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
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-tool-acct`,
        checkpointer,
        input: { scope: scope(), question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_ACCOUNTING_UNAVAILABLE' });
  });

  it('maps unexpected tool-choice failures to LLM_PROVIDER_ERROR', async () => {
    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockRejectedValueOnce(new Error('tool choice socket hang up'));
    const checkpointer = new MemorySaver();
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-tool-llmerr`,
        checkpointer,
        input: { scope: scope(), question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
  });

  it('rethrows KNOWLEDGE_UPDATING and maps unexpected executeTool errors', async () => {
    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'explore_code',
        toolArgs: { query: 'x' },
      }),
    );
    mockExecuteTool.mockRejectedValueOnce(ApiError.fromCode('KNOWLEDGE_UPDATING'));
    const checkpointer = new MemorySaver();
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-updating`,
        checkpointer,
        input: { scope: scope(), question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_UPDATING' });

    mockGenerateText.mockResolvedValueOnce(llmResult(decision())).mockResolvedValueOnce(
      llmResult({
        action: 'call_tool',
        toolName: 'search_documents',
        toolArgs: { query: 'x' },
      }),
    );
    mockExecuteTool.mockRejectedValueOnce(new Error('unexpected tool failure'));
    await expect(
      invokeChatGraph({
        threadId: `${threadId}-tool-boom`,
        checkpointer,
        input: { scope: scope(), question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
  });

  it('treats non-accounting tool-choice repair failures as finish retrieval', async () => {
    mockGenerateText
      .mockResolvedValueOnce(llmResult(decision()))
      .mockResolvedValueOnce({
        text: '{bad',
        usage: null,
        durationMs: 1,
        modelId: 'test-model',
        contextMetrics: {},
        enableThinking: false,
      })
      .mockRejectedValueOnce(new Error('repair failed'));
    const checkpointer = new MemorySaver();
    const result = await invokeChatGraph({
      threadId: `${threadId}-tool-repair-fail`,
      checkpointer,
      input: { scope: scope(), question: 'q' },
    });
    expect(result.retrievalComplete).toBe(true);
  });
});
