/**
 * LangGraph chat workflow: load context, UNDERSTAND, clarify interrupt,
 * AGENT_TOOLS loop with run budgets, or early abstain. No HTTP or SSE —
 * phase 50 maps onStage hooks to the stream; phase 49 adds DRAFT/VERIFY/PERSIST.
 */
import { generateText } from './llm.js';
import { randomUUID } from 'node:crypto';
import { buildConversationContext } from './conversationContext.js';
import { ApiError, caughtErrorFields } from '../../platform/errors.js';
import { executeTool, listToolDefinitionsForSchema } from './agentTools.js';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import {
  assertRunBudget,
  getRunBudgetConfig,
  applyLlmUsageToRunBudget,
  applyModelCallToRunBudget,
  applyToolUsageToRunBudget,
  ensureRunMonotonicStartedAt,
} from './runBudget.js';
import {
  buildChatGraphThreadId,
  parseChatGraphThreadId,
  CLARIFICATION_MAX_ROUNDS,
  toolChoiceDecisionSchema,
  understandDecisionSchema,
  createMongoChatCheckpointer,
} from './chatGraph.helper.js';

export {
  CLARIFICATION_MAX_ROUNDS,
  buildChatGraphThreadId,
  createMongoChatCheckpointer,
  parseChatGraphThreadId,
  toolChoiceDecisionSchema,
  understandDecisionSchema,
} from './chatGraph.helper.js';

/** Stage names this phase may emit for phase 50 SSE mapping. */
export const CHAT_GRAPH_STAGE_VALUES = Object.freeze([
  'understanding_question',
  'awaiting_clarification',
  'abstain_early',
  'searching_code',
  'reviewing_sources',
]);

const DOCUMENT_TOOL_NAMES = new Set(['search_documents', 'list_documents', 'read_document_slice', 'read_file_slice']);

const ChatGraphState = Annotation.Root({
  scope: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  question: Annotation({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  rewrittenQuestion: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  needsClarification: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  clarificationQuestions: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  clarificationSet: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  clarificationAnswers: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  clarifyRoundCount: Annotation({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  route: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  contextSegments: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  summarySegment: Annotation({
    reducer: (_left, right) => right ?? _left,
    default: () => null,
  }),
  metrics: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  cumulativeInputTokens: Annotation({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  cumulativeOutputTokens: Annotation({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  cumulativeToolResultBytes: Annotation({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  totalCalls: Annotation({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  toolResults: Annotation({
    reducer: (left, right) => {
      if (!Array.isArray(right) || right.length === 0) {
        return left ?? [];
      }
      return [...(left ?? []), ...right];
    },
    default: () => [],
  }),
  budgetExhausted: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  retrievalComplete: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  toolStop: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  runMonotonicStartedAt: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  startedAt: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

/**
 * Compiles the chat graph (UNDERSTAND + AGENT_TOOLS).
 * @param {{
 *   checkpointer?: object,
 *   onStage?: (event: { stage: string, data?: object }) => void,
 * }} [deps] Optional saver and stage hook (phase 50).
 * @returns {object} Compiled LangGraph app.
 */
export function compileChatGraph(deps = {}) {
  const onStage = typeof deps.onStage === 'function' ? deps.onStage : () => {};
  const checkpointer = deps.checkpointer ?? createMongoChatCheckpointer();

  const graph = new StateGraph(ChatGraphState)
    .addNode('load_context', (state) => runLoadContextNode(state))
    .addNode('understand', (state) => runUnderstandNode(state, onStage))
    .addNode('clarify_set', (state) => runClarifySetNode(state, onStage))
    .addNode('clarify_wait', (state) => runClarifyWaitNode(state))
    .addNode('abstain_early', (state) => runAbstainEarlyNode(state, onStage))
    .addNode('agent_tools', (state) => runAgentToolsNode(state, onStage))
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'understand')
    .addConditionalEdges('understand', routeAfterUnderstand, {
      clarify_set: 'clarify_set',
      abstain_early: 'abstain_early',
      retrieve: 'agent_tools',
    })
    .addEdge('clarify_set', 'clarify_wait')
    .addConditionalEdges('clarify_wait', routeAfterClarifyWait, {
      understand: 'understand',
      abstain_early: 'abstain_early',
    })
    .addEdge('abstain_early', END)
    .addConditionalEdges('agent_tools', routeAfterAgentTools, {
      agent_tools: 'agent_tools',
      end: END,
    });

  return graph.compile({ checkpointer });
}

/**
 * Starts a chat graph run for one assistant message thread.
 * @param {{
 *   threadId: string,
 *   input: {
 *     scope: object,
 *     question: string,
 *   },
 *   onStage?: (event: { stage: string, data?: object }) => void,
 *   checkpointer?: object,
 *   compiled?: object,
 * }} args Invoke args.
 * @returns {Promise<object>} Final state or interrupt payload on clarify.
 */
export async function invokeChatGraph(args) {
  const onStage = typeof args.onStage === 'function' ? args.onStage : () => {};
  const compiled = args.compiled ?? compileChatGraph({ checkpointer: args.checkpointer, onStage });
  const parsed = parseChatGraphThreadId(args.threadId);
  const result = await compiled.invoke(
    {
      scope: args.input.scope,
      question: args.input.question,
      startedAt: new Date().toISOString(),
      runMonotonicStartedAt: ensureRunMonotonicStartedAt(null),
    },
    {
      configurable: {
        thread_id: args.threadId,
        org_id: parsed.orgId,
      },
    },
  );
  return result;
}

/**
 * Resumes a clarify interrupt with the full answer map (phase 52 later).
 * @param {{
 *   threadId: string,
 *   clarificationSetId: string,
 *   answers: Record<string, string | string[]>,
 *   onStage?: (event: { stage: string, data?: object }) => void,
 *   checkpointer?: object,
 *   compiled?: object,
 * }} args Resume args.
 * @returns {Promise<object>} Continued graph state.
 */
export async function resumeChatGraphFromClarification(args) {
  const onStage = typeof args.onStage === 'function' ? args.onStage : () => {};
  const compiled = args.compiled ?? compileChatGraph({ checkpointer: args.checkpointer, onStage });
  const parsed = parseChatGraphThreadId(args.threadId);
  return compiled.invoke(
    new Command({
      resume: {
        clarificationSetId: args.clarificationSetId,
        answers: args.answers,
      },
    }),
    {
      configurable: {
        thread_id: args.threadId,
        org_id: parsed.orgId,
      },
    },
  );
}

/**
 * Loads conversation context segments for UNDERSTAND.
 * @param {object} state Graph state.
 * @returns {Promise<object>} Partial state update.
 */
async function runLoadContextNode(state) {
  const scope = state.scope;
  if (!scope?.orgId || !scope?.projectId || !scope?.conversationId || !scope?.userId) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: { reason: 'chat_graph_scope_incomplete' } });
  }
  const context = await buildConversationContext(scope.orgId, scope.projectId, scope.conversationId, {
    actorUserId: scope.userId,
  });
  return {
    contextSegments: context.segments,
    summarySegment: context.summarySegment,
    runMonotonicStartedAt: ensureRunMonotonicStartedAt(state.runMonotonicStartedAt),
  };
}

/**
 * Runs UNDERSTAND with thinking disabled and validated structured JSON.
 * @param {object} state Graph state.
 * @param {(event: { stage: string, data?: object }) => void} onStage Stage hook.
 * @returns {Promise<object>} Partial state update.
 */
async function runUnderstandNode(state, onStage) {
  const segments = buildUnderstandSegments(state);
  const abortSignal = state.scope?.abortSignal;
  let decision;
  try {
    decision = await requestUnderstandDecision(segments, state.summarySegment, false, abortSignal);
  } catch (error) {
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  if (!decision) {
    try {
      decision = await requestUnderstandDecision(segments, state.summarySegment, true, abortSignal);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONTEXT_ACCOUNTING_UNAVAILABLE') {
        throw error;
      }
      decision = null;
    }
  }

  if (!decision) {
    fireStage(onStage, 'understanding_question', { route: 'abstain_early', repairFailed: true });
    return {
      rewrittenQuestion: state.question,
      needsClarification: false,
      clarificationQuestions: [],
      route: 'abstain_early',
    };
  }

  const tokens = applyLlmUsageToRunBudget(state, decision.usage);
  fireStage(onStage, 'understanding_question', {
    route: decision.needsClarification ? 'clarify' : decision.route,
  });
  return {
    rewrittenQuestion: decision.rewrittenQuestion,
    needsClarification: decision.needsClarification,
    clarificationQuestions: decision.clarificationQuestions,
    route: decision.route,
    metrics: decision.contextMetrics ?? null,
    ...tokens,
  };
}

/**
 * Builds and stores the clarification set; fires awaiting_clarification.
 * @param {object} state Graph state.
 * @param {(event: { stage: string, data?: object }) => void} onStage Stage hook.
 * @returns {object} Partial state update.
 */
function runClarifySetNode(state, onStage) {
  // Max rounds are enforced in routeAfterUnderstand before this node runs.
  const roundIndex = state.clarifyRoundCount ?? 0;
  const clarificationSet = buildClarificationSet(state.clarificationQuestions ?? [], roundIndex);
  fireStage(onStage, 'awaiting_clarification', { clarificationSet });
  return { clarificationSet };
}

/**
 * Interrupts until phase 52 resumes with answers, then binds them into state.
 * @param {object} state Graph state.
 * @returns {object} Partial state update.
 */
function runClarifyWaitNode(state) {
  const clarificationSet = state.clarificationSet;
  const resumePayload = interrupt(clarificationSet);
  const answers = resumePayload?.answers ?? resumePayload;
  const resumedSetId = resumePayload?.clarificationSetId;
  if (resumedSetId && clarificationSet?.clarificationSetId && String(resumedSetId) !== String(clarificationSet.clarificationSetId)) {
    return {
      needsClarification: false,
      route: 'abstain_early',
      clarificationAnswers: null,
    };
  }
  return {
    clarificationAnswers: answers,
    clarifyRoundCount: (state.clarifyRoundCount ?? 0) + 1,
    needsClarification: false,
  };
}

/**
 * Terminal early-abstain path before tools (phase 49 persists later).
 * @param {object} state Graph state.
 * @param {(event: { stage: string, data?: object }) => void} onStage Stage hook.
 * @returns {object} Partial state update.
 */
function runAbstainEarlyNode(state, onStage) {
  fireStage(onStage, 'abstain_early');
  return {
    route: 'abstain_early',
    needsClarification: false,
  };
}

/**
 * One AGENT_TOOLS iteration: budget check → tool-choice LLM → optional executeTool.
 * @param {object} state Graph state.
 * @param {(event: { stage: string, data?: object }) => void} onStage Stage hook.
 * @returns {Promise<object>} Partial state update.
 */
async function runAgentToolsNode(state, onStage) {
  const runMonotonicStartedAt = ensureRunMonotonicStartedAt(state.runMonotonicStartedAt);
  let working = { ...state, runMonotonicStartedAt };
  const runBudgetConfig = getRunBudgetConfig();

  if (isRunAborted(working.scope?.abortSignal)) {
    return { runMonotonicStartedAt, retrievalComplete: true };
  }

  try {
    assertRunBudget(working, runBudgetConfig);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'RUN_BUDGET_EXCEEDED') {
      return { budgetExhausted: true, runMonotonicStartedAt };
    }
    throw error;
  }

  let decision;
  try {
    decision = await requestToolChoiceDecision(working, false);
  } catch (error) {
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  if (!decision) {
    try {
      decision = await requestToolChoiceDecision(working, true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONTEXT_ACCOUNTING_UNAVAILABLE') {
        throw error;
      }
      decision = null;
    }
  }

  if (!decision) {
    return {
      runMonotonicStartedAt,
      retrievalComplete: true,
    };
  }

  const afterModelTokens = applyLlmUsageToRunBudget(working, decision.usage);
  const afterModelCalls = applyModelCallToRunBudget(working);
  working = {
    ...working,
    ...afterModelTokens,
    ...afterModelCalls,
  };

  if (decision.action === 'finish_retrieval') {
    return {
      runMonotonicStartedAt,
      ...afterModelTokens,
      ...afterModelCalls,
      retrievalComplete: true,
    };
  }

  if (isRunAborted(working.scope?.abortSignal)) {
    return {
      runMonotonicStartedAt,
      ...afterModelTokens,
      ...afterModelCalls,
      retrievalComplete: true,
    };
  }

  try {
    assertRunBudget(working, runBudgetConfig);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'RUN_BUDGET_EXCEEDED') {
      return {
        budgetExhausted: true,
        runMonotonicStartedAt,
        ...afterModelTokens,
        ...afterModelCalls,
      };
    }
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  const toolName = decision.toolName;
  const stage = stageForToolName(toolName);
  if (stage) {
    fireStage(onStage, stage, { toolName });
  }

  const toolScope = buildToolExecutionScope(working.scope);
  const budgetState = buildToolBudgetState(working.scope);
  let toolResult;
  try {
    toolResult = await executeTool({
      name: toolName,
      args: decision.toolArgs ?? {},
      scope: toolScope,
      budgetState,
    });
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'KNOWLEDGE_UNAVAILABLE' || error.code === 'KNOWLEDGE_UPDATING')) {
      throw error;
    }
    if (error instanceof ApiError && error.code === 'TOOL_UNKNOWN') {
      throw error;
    }
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  const afterTool = applyToolUsageToRunBudget(working, toolResult.usage);
  /** @type {object} */
  const update = {
    runMonotonicStartedAt,
    ...afterModelTokens,
    totalCalls: afterTool.totalCalls,
    cumulativeToolResultBytes: afterTool.cumulativeToolResultBytes,
    toolResults: toolResult.evidenceRecords ?? [],
  };
  if (toolResult.stop) {
    update.toolStop = toolResult.stop;
    update.retrievalComplete = true;
  }
  return update;
}

/**
 * Conditional edge after UNDERSTAND.
 * @param {object} state Graph state.
 * @returns {'clarify_set' | 'abstain_early' | 'retrieve'}
 */
function routeAfterUnderstand(state) {
  if (state.needsClarification) {
    if ((state.clarifyRoundCount ?? 0) >= CLARIFICATION_MAX_ROUNDS) {
      return 'abstain_early';
    }
    return 'clarify_set';
  }
  if (state.route === 'abstain_early') {
    return 'abstain_early';
  }
  return 'retrieve';
}

/**
 * After clarify resume: continue UNDERSTAND unless the wait node forced early abstain.
 * @param {object} state Graph state.
 * @returns {'understand' | 'abstain_early'}
 */
function routeAfterClarifyWait(state) {
  if (state.route === 'abstain_early') {
    return 'abstain_early';
  }
  return 'understand';
}

/**
 * After AGENT_TOOLS: loop while retrieval continues; otherwise END for phase 49.
 * @param {object} state Graph state.
 * @returns {'agent_tools' | 'end'}
 */
function routeAfterAgentTools(state) {
  if (state.budgetExhausted || state.toolStop || state.retrievalComplete) {
    return 'end';
  }
  return 'agent_tools';
}

/**
 * Calls generateText for UNDERSTAND and validates the decision JSON.
 * @param {object[]} segments Budgeter segments.
 * @param {object | undefined} summarySegment Summary segment.
 * @param {boolean} repair Whether this is the repair retry.
 * @param {AbortSignal | undefined} abortSignal Run cancel.
 * @returns {Promise<object | null>} Parsed decision plus usage/metrics, or null.
 */
async function requestUnderstandDecision(segments, summarySegment, repair, abortSignal) {
  const callSegments = repair
    ? [
        ...segments,
        {
          id: 'understand_repair',
          kind: 'system',
          content:
            'Previous structured output was invalid. Reply with JSON only matching rewrittenQuestion, needsClarification, clarificationQuestions, route (retrieve|abstain_early).',
          protected: true,
        },
      ]
    : segments;
  const result = await generateText({
    purpose: 'understand',
    enableThinking: false,
    segments: callSegments,
    summarySegment,
    outputSchema: understandDecisionJsonSchema(),
    abortSignal,
  });
  const parsed = parseUnderstandDecisionText(result.text);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    usage: result.usage,
    contextMetrics: result.contextMetrics,
    enableThinking: result.enableThinking,
  };
}

/**
 * Calls generateText for tool choice and validates the decision JSON.
 * @param {object} state Graph state.
 * @param {boolean} repair Whether this is the repair retry.
 * @returns {Promise<object | null>}
 */
async function requestToolChoiceDecision(state, repair) {
  const segments = buildToolChoiceSegments(state, repair);
  const result = await generateText({
    purpose: 'tool_choice',
    enableThinking: false,
    segments,
    outputSchema: toolChoiceDecisionJsonSchema(),
    abortSignal: state.scope?.abortSignal,
  });
  const parsed = parseToolChoiceDecisionText(result.text);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    usage: result.usage,
    contextMetrics: result.contextMetrics,
  };
}

/**
 * JSON Schema for UNDERSTAND Output.json (Zod validated after parse).
 * @returns {object}
 */
function understandDecisionJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['rewrittenQuestion', 'needsClarification', 'clarificationQuestions', 'route'],
    properties: {
      rewrittenQuestion: { type: 'string' },
      needsClarification: { type: 'boolean' },
      clarificationQuestions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'prompt'],
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['single_select', 'multi_select', 'free_text'] },
            prompt: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      route: { type: 'string', enum: ['retrieve', 'abstain_early'] },
    },
  };
}

/**
 * JSON Schema for tool-choice Output.json.
 * @returns {object}
 */
function toolChoiceDecisionJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['call_tool', 'finish_retrieval'] },
      toolName: {
        type: 'string',
        enum: ['explore_code', 'search_documents', 'list_documents', 'read_document_slice', 'read_file_slice', 'abstain'],
      },
      toolArgs: { type: 'object', additionalProperties: true },
      reason: { type: 'string' },
    },
  };
}

/**
 * Parses and validates UNDERSTAND model text.
 * @param {string} text Model text.
 * @returns {object | null}
 */
function parseUnderstandDecisionText(text) {
  let raw;
  try {
    raw = JSON.parse(typeof text === 'string' && text !== '' ? text : 'null');
  } catch {
    return null;
  }
  const result = understandDecisionSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Parses and validates tool-choice model text.
 * @param {string} text Model text.
 * @returns {object | null}
 */
function parseToolChoiceDecisionText(text) {
  let raw;
  try {
    raw = JSON.parse(typeof text === 'string' && text !== '' ? text : 'null');
  } catch {
    return null;
  }
  const result = toolChoiceDecisionSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Builds budgeter segments for UNDERSTAND (context + question + prior answers).
 * @param {object} state Graph state.
 * @returns {object[]}
 */
function buildUnderstandSegments(state) {
  /** @type {object[]} */
  const segments = [...(state.contextSegments ?? [])];
  segments.push({
    id: 'system_understand',
    kind: 'system',
    content:
      'Rewrite the user question using conversation context; decide if clarification is needed; do not answer the project question yet. Return JSON only.',
    protected: true,
  });
  segments.push({
    id: 'user_question',
    kind: 'user_question',
    content: String(state.question ?? ''),
    protected: true,
  });
  if (state.clarificationAnswers && typeof state.clarificationAnswers === 'object') {
    segments.push({
      id: 'clarification_answers',
      kind: 'turn',
      role: 'user',
      content: `Clarification answers: ${JSON.stringify(state.clarificationAnswers)}`,
    });
  }
  return segments;
}

/**
 * Builds budgeter segments for tool choice (rewritten question + compact evidence ids).
 * @param {object} state Graph state.
 * @param {boolean} repair Whether this is the repair retry.
 * @returns {object[]}
 */
function buildToolChoiceSegments(state, repair) {
  const toolNames = listToolDefinitionsForSchema()
    .map((definition) => definition.name)
    .join(', ');
  const evidenceSummary = (state.toolResults ?? []).map((record) => ({
    evidenceId: record.evidenceId,
    path: record.path ?? null,
    kind: record.kind ?? null,
  }));
  /** @type {object[]} */
  const segments = [
    {
      id: 'system_tool_choice',
      kind: 'system',
      content:
        `Choose one scoped tool or finish retrieval. Allowed tools: ${toolNames}. ` +
        'Return JSON only with action call_tool|finish_retrieval. Do not invent evidence. Omit private reasoning.',
      protected: true,
    },
    {
      id: 'rewritten_question',
      kind: 'user_question',
      content: String(state.rewrittenQuestion ?? state.question ?? ''),
      protected: true,
    },
    {
      id: 'tool_results_summary',
      kind: 'turn',
      role: 'assistant',
      content: `Evidence so far (ids/paths only): ${JSON.stringify(evidenceSummary)}`,
    },
  ];
  if (repair) {
    segments.push({
      id: 'tool_choice_repair',
      kind: 'system',
      content: 'Previous structured output was invalid. Reply with JSON only: action call_tool|finish_retrieval; toolName required when call_tool.',
      protected: true,
    });
  }
  return segments;
}

/**
 * Maps a tool name to an observable stage (or null for abstain).
 * @param {string} toolName Tool name.
 * @returns {'searching_code' | 'reviewing_sources' | null}
 */
function stageForToolName(toolName) {
  if (toolName === 'explore_code') {
    return 'searching_code';
  }
  if (DOCUMENT_TOOL_NAMES.has(toolName)) {
    return 'reviewing_sources';
  }
  return null;
}

/**
 * Builds executeTool scope from graph run scope (phase 50 supplies workspace fields).
 * @param {object | null} scope Graph scope.
 * @returns {object}
 * @throws {ApiError} When tool scope fields are missing.
 */
function buildToolExecutionScope(scope) {
  if (!scope?.orgId || !scope?.projectId || !scope?.knowledgeVersionId || !scope?.workspaceRoot) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: { reason: 'chat_graph_tool_scope_incomplete' } });
  }
  return {
    orgId: scope.orgId,
    projectId: scope.projectId,
    knowledgeVersionId: scope.knowledgeVersionId,
    workspaceRoot: scope.workspaceRoot,
    correlationId: scope.correlationId ?? null,
    abortSignal: scope.abortSignal,
  };
}

/**
 * Builds executeTool budgetState from scope (caller supplies modelArtifactRef).
 * @param {object | null} scope Graph scope.
 * @returns {object}
 * @throws {ApiError} When budgetState.modelArtifactRef is missing.
 */
function buildToolBudgetState(scope) {
  if (!scope?.budgetState?.modelArtifactRef) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: { reason: 'chat_graph_tool_budget_state_missing' } });
  }
  return scope.budgetState;
}

/**
 * Normalises clarification questions into a stable interrupt payload.
 * @param {object[]} questions Model questions.
 * @param {number} roundIndex 0-based round.
 * @returns {object}
 */
function buildClarificationSet(questions, roundIndex) {
  const normalised = (Array.isArray(questions) ? questions : []).map((question, index) => {
    /** @type {{ id: string, type: string, prompt: string, options?: string[] }} */
    const entry = {
      id: typeof question?.id === 'string' && question.id !== '' ? question.id : `q${index + 1}`,
      type: question.type,
      prompt: question.prompt,
    };
    if (Array.isArray(question.options)) {
      entry.options = question.options;
    }
    return entry;
  });
  return {
    clarificationSetId: `clr_r${roundIndex}_${randomUUID()}`,
    questions: normalised,
    issuedAt: new Date().toISOString(),
    roundIndex,
  };
}

/**
 * @param {AbortSignal | undefined} abortSignal Run cancel.
 * @returns {boolean}
 */
function isRunAborted(abortSignal) {
  return Boolean(abortSignal?.aborted);
}

/**
 * Invokes the stage hook without letting throws break the graph/checkpoint.
 * @param {(event: { stage: string, data?: object }) => void} onStage Hook.
 * @param {string} stage Stage name.
 * @param {object} [data] Optional payload.
 * @returns {void}
 */
function fireStage(onStage, stage, data) {
  try {
    onStage(data === undefined ? { stage } : { stage, data });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'chat graph stage hook failed',
        stage,
        ...caughtErrorFields(error),
      }),
    );
  }
}
