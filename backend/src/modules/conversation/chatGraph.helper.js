/**
 * Overflow helpers for chatGraph: UNDERSTAND / tool-choice Zod schemas, the
 * Mongo LangGraph checkpointer, DRAFT / VERIFY / PERSIST runners, and
 * direct conversational / general replies (ADR 0039).
 * Used only by chatGraph.js.
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { streamText, generateText } from './llm.js';
import { findProjectById } from '../masters/index.js';
import { finalizeAssistantMessage } from './conversation.helper.js';
import { ApiError, caughtErrorFields } from '../../platform/errors.js';
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { ChatCheckpoint } from '../../models/chatCheckpoint.model.js';
import { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import { applyLlmUsageToRunBudget, applyModelCallToRunBudget, assertRunBudget, getRunBudgetConfig } from './runBudget.js';

/** Initial clarify set is round 0; at most one follow-up (round 1). */
export const CLARIFICATION_MAX_ROUNDS = 2;

/** VERIFY may send the run back to AGENT_TOOLS at most once. */
export const MAX_VERIFY_REVISE = 1;

/** Evidence id pattern cited in draft Markdown (ev_01, ev_12, …). */
const EVIDENCE_ID_PATTERN = /\bev_(\d+)\b/gi;

/** Heuristic: draft mentions a project path or evidence id. */
const PROJECT_CLAIM_PATTERN = /\bev_\d+\b|`[^`]+\/[^`]+`|\b(?:src|docs|backend|frontend)\/[\w./-]+/i;

/** Clarification question types the UNDERSTAND model may emit. */
export const CLARIFICATION_QUESTION_TYPES = Object.freeze(['single_select', 'multi_select', 'free_text']);

/**
 * Routes UNDERSTAND may choose (clarify uses needsClarification, not route).
 * Direct replies: converse (greetings / identity) and general_knowledge (off-topic).
 * project_overview retrieves first, then falls back to the saved description.
 */
export const UNDERSTAND_ROUTE_VALUES = Object.freeze(['retrieve', 'project_overview', 'converse', 'general_knowledge', 'abstain_early']);

/**
 * Markdown note prepended to general-knowledge replies so they stay distinct
 * from grounded project answers after reload.
 */
export const DIRECT_REPLY_GENERAL_NOTE = "_General answer, not based on this project's sources._";

/**
 * Markdown note prepended when a project-overview question falls back to the
 * saved project description because indexed sources had no evidence.
 */
export const DIRECT_REPLY_DESCRIPTION_NOTE = "_Based on the project's saved description, not indexed sources._";

/** Fixed copy when project-overview has no indexed evidence and no description. */
export const DIRECT_REPLY_EMPTY_DESCRIPTION =
  'No project overview is available yet. Ask a concrete question about the code or documentation, or add a project description.';

/** Tool-choice actions for AGENT_TOOLS (ask_clarification → existing clarify interrupt). */
export const TOOL_CHOICE_ACTION_VALUES = Object.freeze(['call_tool', 'finish_retrieval', 'ask_clarification']);

/** Scoped agent tools the model may request (phase 46). */
export const AGENT_TOOL_NAME_VALUES = Object.freeze([
  'explore_code',
  'search_documents',
  'list_documents',
  'read_document_slice',
  'read_file_slice',
  'abstain',
]);

/**
 * One clarification question from UNDERSTAND or tool-choice `ask_clarification`.
 * Shape only — usable-option gates (e.g. select needs ≥2 options) live in the graph.
 */
export const clarificationQuestionSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.enum(CLARIFICATION_QUESTION_TYPES),
  prompt: z.string().min(1),
  options: z.array(z.string()).optional(),
});

/**
 * Zod schema for the UNDERSTAND structured decision.
 * Extra keys are stripped (not `.strict()` — models often emit helper fields).
 * Invalid route fails validation. `rewrittenQuestion` may be omitted — the graph
 * falls back to the original user question.
 */
export const understandDecisionSchema = z.object({
  rewrittenQuestion: z
    .string()
    .optional()
    .transform((value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)),
  needsClarification: z.boolean().optional().default(false),
  clarificationQuestions: z.array(clarificationQuestionSchema).optional().default([]),
  route: z.enum(UNDERSTAND_ROUTE_VALUES),
});

/**
 * Zod schema for AGENT_TOOLS tool-choice structured output.
 * `reason` is optional short product text — never chain-of-thought / SSE.
 * Extra keys are stripped so soft-parsed model JSON still validates.
 * `ask_clarification` may carry `clarificationQuestions`; usable gates are in the graph.
 */
export const toolChoiceDecisionSchema = z
  .object({
    action: z.enum(TOOL_CHOICE_ACTION_VALUES),
    toolName: z.enum(AGENT_TOOL_NAME_VALUES).optional(),
    // Models sometimes emit null/arrays; only plain objects become tool args.
    toolArgs: z
      .unknown()
      .optional()
      .transform((value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined)),
    reason: z.string().max(500).optional(),
    clarificationQuestions: z.array(clarificationQuestionSchema).optional().default([]),
  })
  .superRefine((value, context) => {
    if (value.action === 'call_tool' && !value.toolName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'toolName is required when action is call_tool',
        path: ['toolName'],
      });
    }
  });

/**
 * Builds the LangGraph thread id for one pending assistant message.
 * @param {string} orgId Tenant id.
 * @param {string} conversationId Conversation id.
 * @param {string} assistantMessageId Pending assistant message id.
 * @returns {string}
 */
export function buildChatGraphThreadId(orgId, conversationId, assistantMessageId) {
  return `${String(orgId)}:${String(conversationId)}:${String(assistantMessageId)}`;
}

/**
 * Parses thread id into scope parts. Fails closed on malformed keys.
 * @param {string} threadId Composite thread id.
 * @returns {{ orgId: string, conversationId: string, assistantMessageId: string }}
 * @throws {Error} When the key is not three colon-separated segments.
 */
export function parseChatGraphThreadId(threadId) {
  const parts = String(threadId ?? '').split(':');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new Error('invalid chat graph threadId');
  }
  return { orgId: parts[0], conversationId: parts[1], assistantMessageId: parts[2] };
}

/**
 * Creates a Mongo BaseCheckpointSaver scoped by orgId + threadId.
 * @param {{ ChatCheckpointModel?: typeof ChatCheckpoint }} [options] Test seam for the model only.
 * @returns {MongoChatCheckpointer}
 */
export function createMongoChatCheckpointer(options = {}) {
  return new MongoChatCheckpointer(options.ChatCheckpointModel ?? ChatCheckpoint);
}

/**
 * Tenant-aware LangGraph checkpointer backed by `chatCheckpoints`.
 */
class MongoChatCheckpointer extends BaseCheckpointSaver {
  /**
   * @param {typeof ChatCheckpoint} ChatCheckpointModel Mongoose model.
   */
  constructor(ChatCheckpointModel) {
    super();
    this.ChatCheckpointModel = ChatCheckpointModel;
  }

  /**
   * Loads one checkpoint tuple for the configured thread.
   * @param {object} config Runnable config with configurable.thread_id.
   * @returns {Promise<object | undefined>}
   */
  async getTuple(config) {
    const threadId = config?.configurable?.thread_id;
    if (threadId === undefined) {
      return undefined;
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      return undefined;
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const requestedId = config.configurable?.checkpoint_id;
    /** @type {object} */
    const filter = {
      orgId: scope.orgObjectId,
      threadId,
      checkpointNs,
      status: ROW_STATUS_ACTIVE,
    };
    let row;
    if (requestedId) {
      row = await this.ChatCheckpointModel.findOne({ ...filter, checkpointId: requestedId }).lean();
    } else {
      row = await this.ChatCheckpointModel.findOne(filter).sort({ createdAt: -1 }).lean();
    }
    if (!row) {
      return undefined;
    }
    return hydrateCheckpointTuple(row, this.serde);
  }

  /**
   * Lists checkpoints for a thread, newest first.
   * @param {object} config Runnable config.
   * @param {{ limit?: number, before?: object }} [options] List options.
   * @returns {AsyncGenerator<object>}
   */
  async *list(config, options = {}) {
    const threadId = config?.configurable?.thread_id;
    if (threadId === undefined) {
      return;
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      return;
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    /** @type {object} */
    const filter = {
      orgId: scope.orgObjectId,
      threadId,
      checkpointNs,
      status: ROW_STATUS_ACTIVE,
    };
    if (options.before?.configurable?.checkpoint_id) {
      const beforeRow = await this.ChatCheckpointModel.findOne({
        ...filter,
        checkpointId: options.before.configurable.checkpoint_id,
      }).lean();
      if (beforeRow?.createdAt) {
        filter.createdAt = { $lt: beforeRow.createdAt };
      }
    }
    let query = this.ChatCheckpointModel.find(filter).sort({ createdAt: -1 });
    if (Number.isFinite(options.limit) && options.limit > 0) {
      query = query.limit(options.limit);
    }
    const rows = await query.lean();
    for (const row of rows) {
      yield hydrateCheckpointTuple(row, this.serde);
    }
  }

  /**
   * Upserts a checkpoint row for the thread.
   * @param {object} config Runnable config.
   * @param {object} checkpoint LangGraph checkpoint.
   * @param {object} metadata LangGraph metadata.
   * @returns {Promise<object>} Config pointing at the stored checkpoint id.
   */
  async put(config, checkpoint, metadata) {
    const threadId = config?.configurable?.thread_id;
    if (threadId === undefined) {
      throw new Error('Failed to put checkpoint: missing thread_id');
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      throw new Error('Failed to put checkpoint: org scope mismatch');
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const parentCheckpointId = config.configurable?.checkpoint_id ?? null;
    const [checkpointType, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
    const [metadataType, metadataBytes] = await this.serde.dumpsTyped(metadata);
    const packedCheckpoint = {
      type: checkpointType,
      data: Buffer.from(checkpointBytes).toString('base64'),
    };
    const packedMetadata = {
      langGraph: {
        type: metadataType,
        data: Buffer.from(metadataBytes).toString('base64'),
      },
      product: {
        conversationId: scope.conversationId,
        assistantMessageId: scope.assistantMessageId,
      },
    };
    await this.ChatCheckpointModel.findOneAndUpdate(
      {
        orgId: scope.orgObjectId,
        threadId,
        checkpointNs,
        checkpointId: checkpoint.id,
        status: ROW_STATUS_ACTIVE,
      },
      {
        $set: {
          parentCheckpointId,
          checkpoint: packedCheckpoint,
          metadata: packedMetadata,
          updatedBy: null,
        },
        $setOnInsert: {
          orgId: scope.orgObjectId,
          threadId,
          checkpointNs,
          checkpointId: checkpoint.id,
          status: ROW_STATUS_ACTIVE,
          createdBy: null,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
        org_id: scope.orgId,
      },
    };
  }

  /**
   * Appends pending writes onto the checkpoint's metadata blob.
   * @param {object} config Runnable config with checkpoint_id.
   * @param {Array<[string, unknown]>} writes Channel writes.
   * @param {string} taskId Task id.
   * @param {string} [taskPath] Optional task path for ordering.
   * @returns {Promise<void>}
   */
  async putWrites(config, writes, taskId, taskPath = '') {
    const threadId = config?.configurable?.thread_id;
    const checkpointId = config?.configurable?.checkpoint_id;
    if (threadId === undefined || checkpointId === undefined) {
      throw new Error('Failed to put writes: missing thread_id or checkpoint_id');
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      throw new Error('Failed to put writes: org scope mismatch');
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const row = await this.ChatCheckpointModel.findOne({
      orgId: scope.orgObjectId,
      threadId,
      checkpointNs,
      checkpointId,
      status: ROW_STATUS_ACTIVE,
    });
    if (!row) {
      return;
    }
    const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
    const pendingWrites = Array.isArray(metadata.pendingWrites) ? [...metadata.pendingWrites] : [];
    let idx = pendingWrites.length;
    for (const [channel, value] of writes) {
      const [valueType, valueBytes] = await this.serde.dumpsTyped(value);
      pendingWrites.push({
        taskId,
        taskPath,
        idx,
        channel,
        type: valueType,
        data: Buffer.from(valueBytes).toString('base64'),
      });
      idx += 1;
    }
    metadata.pendingWrites = pendingWrites;
    row.metadata = metadata;
    row.updatedBy = null;
    await row.save();
  }

  /**
   * Soft-deletes every active checkpoint for a thread in the parsed org.
   * @param {string} threadId Thread id.
   * @returns {Promise<void>}
   */
  async deleteThread(threadId) {
    const scope = parseChatGraphThreadId(threadId);
    if (!mongoose.isValidObjectId(scope.orgId)) {
      return;
    }
    await this.ChatCheckpointModel.updateMany(
      {
        orgId: new mongoose.Types.ObjectId(scope.orgId),
        threadId,
        status: ROW_STATUS_ACTIVE,
      },
      { $set: { status: ROW_STATUS_DELETED, updatedBy: null } },
    );
  }
}

/**
 * Resolves org scope from thread id and optional configurable.org_id.
 * Returns null when org_id is present and does not match (fail closed).
 * @param {object} config Runnable config.
 * @param {string} threadId Thread id.
 * @returns {{ orgId: string, orgObjectId: import('mongoose').Types.ObjectId, conversationId: string, assistantMessageId: string } | null}
 */
function resolveCheckpointScope(config, threadId) {
  let parsed;
  try {
    parsed = parseChatGraphThreadId(threadId);
  } catch {
    return null;
  }
  if (!mongoose.isValidObjectId(parsed.orgId)) {
    return null;
  }
  const claimedOrgId = config?.configurable?.org_id;
  if (claimedOrgId !== undefined && String(claimedOrgId) !== parsed.orgId) {
    return null;
  }
  return {
    orgId: parsed.orgId,
    orgObjectId: new mongoose.Types.ObjectId(parsed.orgId),
    conversationId: parsed.conversationId,
    assistantMessageId: parsed.assistantMessageId,
  };
}

/**
 * Zod schema for optional LLM VERIFY structured output.
 */
export const verifyLlmDecisionSchema = z
  .object({
    result: z.enum(['pass', 'fail', 'partial', 'abstain']),
    failures: z
      .array(
        z.object({
          claim: z.string(),
          reason: z.string(),
        }),
      )
      .optional(),
  })
  .strict();

/**
 * Streams a grounded draft from tool evidence; never forwards private thinking.
 * @param {object} state Graph state.
 * @param {{
 *   onStage: (event: { stage: string, data?: object }) => void,
 *   onDelta: (text: string) => void,
 * }} hooks Stream hooks.
 * @returns {Promise<object>} Partial state update.
 */
export async function runDraftAnswerNode(state, hooks) {
  const onStage = hooks.onStage;
  const onDelta = hooks.onDelta;
  fireSafeHook(onStage, 'generating_answer');
  const stages = appendStage(state.stages, 'generating_answer');
  const toolResults = Array.isArray(state.toolResults) ? state.toolResults : [];
  const segments = buildDraftSegments(state, toolResults);
  const abortSignal = state.scope?.abortSignal;

  let stream;
  try {
    stream = await streamText({
      purpose: 'draft',
      enableThinking: true,
      segments,
      summarySegment: state.summarySegment,
      abortSignal,
    });
  } catch (error) {
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  let draftAnswer = '';
  try {
    for await (const chunk of stream.textStream) {
      if (typeof chunk === 'string' && chunk.length > 0) {
        draftAnswer += chunk;
        fireSafeDelta(onDelta, chunk);
      }
    }
  } catch (error) {
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  const usage = await stream.usage;
  const durationMs = await stream.durationMs;
  const tokenUpdate = applyLlmUsageToRunBudget(state, usage);
  const callUpdate = applyModelCallToRunBudget(state);

  return {
    draftAnswer,
    answerContent: draftAnswer,
    stages,
    metrics: stream.contextMetrics ?? state.metrics,
    modelId: stream.modelId ?? null,
    draftUsage: usage ?? null,
    draftDurationMs: Number.isFinite(durationMs) ? durationMs : null,
    ...tokenUpdate,
    ...callUpdate,
  };
}

/**
 * Deterministic-first VERIFY; optional LLM only for remaining ambiguous claims.
 * @param {object} state Graph state.
 * @param {{ onStage: (event: { stage: string, data?: object }) => void }} hooks Stage hook.
 * @returns {Promise<object>} Partial state update.
 */
export async function runVerifyAnswerNode(state, hooks) {
  fireSafeHook(hooks.onStage, 'verifying_answer');
  const stages = appendStage(state.stages, 'verifying_answer');
  const draftAnswer = typeof state.draftAnswer === 'string' ? state.draftAnswer : '';
  const toolResults = Array.isArray(state.toolResults) ? state.toolResults : [];
  const knowledgeVersionId = state.scope?.knowledgeVersionId ? String(state.scope.knowledgeVersionId) : null;

  const deterministic = runDeterministicVerify(draftAnswer, toolResults, knowledgeVersionId);
  let verifyResult = deterministic;

  if (deterministic.result === 'ambiguous') {
    const runBudgetConfig = getRunBudgetConfig();
    let budgetOk = true;
    try {
      assertRunBudget(state, runBudgetConfig);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RUN_BUDGET_EXCEEDED') {
        budgetOk = false;
      } else {
        throw error;
      }
    }
    if (budgetOk) {
      const llmVerify = await requestLlmVerifyDecision(state, draftAnswer, toolResults);
      if (llmVerify) {
        verifyResult = {
          result: llmVerify.result,
          failures: llmVerify.failures ?? deterministic.failures,
          citedEvidenceIds: deterministic.citedEvidenceIds,
        };
        const tokenUpdate = applyLlmUsageToRunBudget(state, llmVerify.usage);
        const callUpdate = applyModelCallToRunBudget(state);
        return finishVerifyState(state, verifyResult, stages, tokenUpdate, callUpdate, llmVerify.usage);
      }
    }
    verifyResult = {
      result: 'abstain',
      failures: deterministic.failures.length > 0 ? deterministic.failures : [{ claim: 'draft', reason: 'ambiguous_claims_unresolved' }],
      citedEvidenceIds: deterministic.citedEvidenceIds,
    };
  }

  return finishVerifyState(state, verifyResult, stages, {}, {}, null);
}

/**
 * Persists a verified (or partial) assistant answer and fires evidence/done hooks.
 * @param {object} state Graph state.
 * @param {{
 *   onEvidence: (evidence: object[]) => void,
 *   onDone: (payload: object) => void,
 *   onError: (error: unknown) => void,
 * }} hooks Persist hooks.
 * @returns {Promise<object>} Partial state update.
 */
export async function runPersistDoneNode(state, hooks) {
  const supportLevel = mapVerifyResultToSupportLevel(state.verifyResult?.result, 'evidence_backed');
  const citedIds = new Set(state.verifyResult?.citedEvidenceIds ?? []);
  const toolResults = Array.isArray(state.toolResults) ? state.toolResults : [];
  const evidence = citedIds.size > 0 ? toolResults.filter((record) => citedIds.has(String(record.evidenceId))) : toolResults;
  const isPartial = state.verifyResult?.result === 'partial';
  let content = typeof state.answerContent === 'string' ? state.answerContent : String(state.draftAnswer ?? '');
  if (isPartial) {
    content = appendPartialWarning(content);
  }
  content = appendPartialKnowledgeWarning(content, state.scope?.knowledgeHealth);

  return persistAssistantOutcome(state, hooks, {
    content,
    messageStatus: 'completed',
    supportLevel: isPartial ? 'partial' : supportLevel,
    evidence,
  });
}

/**
 * Persists an abstain (or failed) assistant message with insufficient-info copy.
 * @param {object} state Graph state.
 * @param {{
 *   onEvidence: (evidence: object[]) => void,
 *   onDone: (payload: object) => void,
 *   onError: (error: unknown) => void,
 * }} hooks Persist hooks.
 * @returns {Promise<object>} Partial state update.
 */
export async function runPersistAbstainNode(state, hooks) {
  let content = typeof state.answerContent === 'string' && state.answerContent.trim() !== '' ? state.answerContent : buildAbstainContent(state);
  content = appendPartialKnowledgeWarning(content, state.scope?.knowledgeHealth);
  const messageStatus = state.persistFailed ? 'failed' : 'abstained';
  return persistAssistantOutcome(state, hooks, {
    content,
    messageStatus,
    supportLevel: messageStatus === 'failed' ? 'insufficient' : 'insufficient',
    evidence: [],
  });
}

/**
 * Streams a conversational or general reply without retrieval or VERIFY.
 * Used for greetings/identity (`converse`), off-topic (`general_knowledge`),
 * and project-overview fallback when tools found no evidence.
 * @param {object} state Graph state.
 * @param {{
 *   onStage: (event: { stage: string, data?: object }) => void,
 *   onDelta: (text: string) => void,
 * }} hooks Stream hooks.
 * @returns {Promise<object>} Partial state update.
 */
export async function runDirectReplyNode(state, hooks) {
  const onStage = hooks.onStage;
  const onDelta = hooks.onDelta;
  fireSafeHook(onStage, 'composing_reply');
  const stages = appendStage(state.stages, 'composing_reply');
  const abortSignal = state.scope?.abortSignal;
  if (abortSignal?.aborted) {
    return { stages, retrievalComplete: true };
  }

  const scope = state.scope ?? {};
  let project = null;
  if (scope.orgId && scope.projectId) {
    try {
      project = await findProjectById(scope.orgId, scope.projectId);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'direct reply project load failed',
          ...caughtErrorFields(error),
        }),
      );
      project = null;
    }
  }
  const projectName = typeof project?.name === 'string' && project.name.trim() !== '' ? project.name.trim() : 'this project';
  const projectDescription = typeof project?.description === 'string' ? project.description.trim() : '';
  const route = state.route;

  if (route === 'project_overview' && projectDescription === '') {
    const emptyContent = DIRECT_REPLY_EMPTY_DESCRIPTION;
    fireSafeDelta(onDelta, emptyContent);
    return {
      draftAnswer: emptyContent,
      answerContent: emptyContent,
      stages,
      modelId: state.modelId ?? null,
    };
  }

  let prefix = '';
  if (route === 'general_knowledge') {
    prefix = `${DIRECT_REPLY_GENERAL_NOTE}\n\n`;
  } else if (route === 'project_overview') {
    prefix = `${DIRECT_REPLY_DESCRIPTION_NOTE}\n\n`;
  }
  if (prefix) {
    fireSafeDelta(onDelta, prefix);
  }

  const segments = buildDirectReplySegments(state, projectName, projectDescription, route);
  let stream;
  try {
    stream = await streamText({
      purpose: 'direct_reply',
      enableThinking: false,
      segments,
      summarySegment: state.summarySegment,
      abortSignal,
    });
  } catch (error) {
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  let body = '';
  try {
    for await (const chunk of stream.textStream) {
      if (typeof chunk === 'string' && chunk.length > 0) {
        body += chunk;
        fireSafeDelta(onDelta, chunk);
      }
    }
  } catch (error) {
    throw error instanceof ApiError ? error : ApiError.fromCode('LLM_PROVIDER_ERROR', { cause: error });
  }

  const usage = await stream.usage;
  const durationMs = await stream.durationMs;
  const tokenUpdate = applyLlmUsageToRunBudget(state, usage);
  const callUpdate = applyModelCallToRunBudget(state);
  const answerContent = `${prefix}${body}`;

  return {
    draftAnswer: answerContent,
    answerContent,
    stages,
    metrics: stream.contextMetrics ?? state.metrics,
    modelId: stream.modelId ?? null,
    draftUsage: usage ?? null,
    draftDurationMs: Number.isFinite(durationMs) ? durationMs : null,
    ...tokenUpdate,
    ...callUpdate,
  };

  /**
   * Builds budgeter segments for a direct reply (persona + project metadata + question).
   * @param {object} replyState Graph state.
   * @param {string} name Project display name.
   * @param {string} description Saved project description.
   * @param {string | null} replyRoute UNDERSTAND route driving the reply.
   * @returns {object[]}
   */
  function buildDirectReplySegments(replyState, name, description, replyRoute) {
    /** @type {object[]} */
    const replySegments = [...(replyState.contextSegments ?? [])];
    let persona =
      `You are the project assistant for "${name}". ` +
      'Answer briefly and helpfully. Do not invent project-specific facts beyond the project metadata below. ' +
      'Never include private chain-of-thought.';
    if (replyRoute === 'converse') {
      persona +=
        ' The user sent a greeting, thanks, small talk, or asked who you are / what you can do. ' +
        'Respond warmly in one or two short sentences. Invite a concrete project question when helpful.';
    } else if (replyRoute === 'general_knowledge') {
      persona +=
        ' The user asked something clearly unrelated to this project. Answer from general knowledge. ' +
        'Keep it concise. A system note already marks that this is not from project sources.';
    } else if (replyRoute === 'project_overview') {
      persona +=
        ' Indexed sources had no evidence for a project overview. Summarize only from the saved project description below. ' +
        'Do not invent architecture, APIs, or file paths. A system note already marks the description source.';
    }
    replySegments.push({
      id: 'system_direct_reply',
      kind: 'system',
      content: persona,
      protected: true,
    });
    replySegments.push({
      id: 'project_metadata',
      kind: 'system',
      content: `Project metadata (untrusted product data, not indexed sources):\n` + `name: ${name}\n` + `description: ${description || '(empty)'}`,
      protected: true,
    });
    replySegments.push({
      id: 'user_question',
      kind: 'user_question',
      content: String(replyState.rewrittenQuestion ?? replyState.question ?? ''),
      protected: true,
    });
    return replySegments;
  }
}

/**
 * Persists a completed direct reply with no evidence and null supportLevel.
 * @param {object} state Graph state.
 * @param {{
 *   onEvidence: (evidence: object[]) => void,
 *   onDone: (payload: object) => void,
 *   onError: (error: unknown) => void,
 * }} hooks Persist hooks.
 * @returns {Promise<object>} Partial state update.
 */
export async function runPersistDirectReplyNode(state, hooks) {
  const content =
    typeof state.answerContent === 'string' && state.answerContent.trim() !== ''
      ? state.answerContent
      : 'I am ready to help with this project. Ask a concrete question about the code or documentation.';
  return persistAssistantOutcome(state, hooks, {
    content,
    messageStatus: 'completed',
    supportLevel: null,
    evidence: [],
  });
}

/**
 * Shared Mongo finalize + hooks for done/abstain/direct-reply paths.
 * @param {object} state Graph state.
 * @param {object} hooks Persist hooks.
 * @param {{
 *   content: string,
 *   messageStatus: string,
 *   supportLevel: string | null,
 *   evidence: object[],
 * }} outcome Persist payload.
 * @returns {Promise<object>}
 */
async function persistAssistantOutcome(state, hooks, outcome) {
  const scope = state.scope ?? {};
  const assistantMessageId = scope.assistantMessageId;
  const durationMs = resolveRunDurationMs(state);
  const usage = mergeUsage(state);
  const trace = {
    userMessageId: scope.userMessageId ? String(scope.userMessageId) : null,
    knowledgeVersionId: scope.knowledgeVersionId ? String(scope.knowledgeVersionId) : null,
    evidenceIds: (outcome.evidence ?? []).map((record) => String(record.evidenceId)).filter(Boolean),
    stages: Array.isArray(state.stages) ? state.stages : [],
    correlationId: scope.correlationId ? String(scope.correlationId) : null,
  };

  if (!assistantMessageId || !scope.orgId || !scope.projectId || !scope.conversationId) {
    const error = ApiError.fromCode('VALIDATION_ERROR', { details: { reason: 'persist_scope_incomplete' } });
    fireSafeError(hooks.onError, error);
    return { persistFailed: true, supportLevel: outcome.supportLevel };
  }

  try {
    await finalizeAssistantMessage({
      orgId: scope.orgId,
      projectId: String(scope.projectId),
      conversationId: String(scope.conversationId),
      assistantMessageId: String(assistantMessageId),
      content: outcome.content,
      messageStatus: outcome.messageStatus,
      evidence: outcome.evidence.length > 0 ? outcome.evidence : null,
      supportLevel: outcome.supportLevel,
      usage,
      durationMs,
      modelId: state.modelId ?? null,
      contextMetrics: state.metrics ?? null,
      knowledgeVersionId: scope.knowledgeVersionId ? String(scope.knowledgeVersionId) : null,
      trace,
      updatedBy: scope.userId ?? null,
    });
  } catch (error) {
    fireSafeError(hooks.onError, error);
    return { persistFailed: true, supportLevel: outcome.supportLevel, answerContent: outcome.content };
  }

  fireSafeEvidence(hooks.onEvidence, outcome.evidence);
  fireSafeDone(hooks.onDone, {
    messageId: String(assistantMessageId),
    usage: usage ?? undefined,
    contextMetrics: state.metrics ?? undefined,
    supportLevel: outcome.supportLevel,
  });

  // Do not await: title must not delay the SSE done path, and static imports of
  // conversation.js here are circular (clarification → chatGraph → helper).
  void import('./conversation.js')
    .then(({ scheduleConversationAutoTitle: scheduleTitle }) =>
      scheduleTitle({
        orgId: scope.orgId,
        projectId: String(scope.projectId),
        conversationId: String(scope.conversationId),
        firstUserContent: typeof state.question === 'string' ? state.question : '',
        assistantMessageId: String(assistantMessageId),
      }),
    )
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'chat graph auto-title failed',
          ...caughtErrorFields(error),
        }),
      );
    });

  return {
    answerContent: outcome.content,
    supportLevel: outcome.supportLevel,
    persistedEvidence: outcome.evidence,
    persistFailed: false,
  };
}

/**
 * Builds DRAFT budgeter segments from rewritten question, short history, and toolResults.
 * @param {object} state Graph state.
 * @param {object[]} toolResults Evidence records.
 * @returns {object[]}
 */
function buildDraftSegments(state, toolResults) {
  const history = (state.contextSegments ?? []).filter((segment) => segment?.kind === 'turn').slice(-6);
  const evidenceBlocks = toolResults.map((record) => ({
    evidenceId: record.evidenceId,
    path: record.path ?? null,
    startLine: record.startLine ?? null,
    endLine: record.endLine ?? null,
    excerpt: record.excerpt ?? '',
    knowledgeVersionId: record.knowledgeVersionId ?? null,
  }));
  return [
    {
      id: 'system_draft',
      kind: 'system',
      content:
        'Answer from the evidence blocks only. Cite evidence ids (ev_NN). Use Markdown. ' +
        'If evidence is insufficient, say so — do not invent project facts. Never include private chain-of-thought.',
      protected: true,
    },
    {
      id: 'rewritten_question',
      kind: 'user_question',
      content: String(state.rewrittenQuestion ?? state.question ?? ''),
      protected: true,
    },
    ...history,
    {
      id: 'tool_results',
      kind: 'turn',
      role: 'user',
      content: `Evidence blocks:\n${JSON.stringify(evidenceBlocks)}`,
    },
  ];
}

/**
 * Programmatic citation / scope checks before any LLM VERIFY call.
 * @param {string} draftAnswer Draft markdown.
 * @param {object[]} toolResults Evidence records.
 * @param {string | null} knowledgeVersionId Run knowledge version.
 * @returns {{ result: string, failures: object[], citedEvidenceIds: string[], ambiguous?: boolean }}
 */
export function runDeterministicVerify(draftAnswer, toolResults, knowledgeVersionId) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const record of toolResults ?? []) {
    const evidenceId = record?.evidenceId != null ? String(record.evidenceId) : '';
    if (evidenceId) {
      byId.set(evidenceId, record);
    }
  }
  const citedEvidenceIds = [...draftAnswer.matchAll(EVIDENCE_ID_PATTERN)].map((match) => `ev_${match[1]}`);
  const uniqueCited = [...new Set(citedEvidenceIds)];
  /** @type {{ claim: string, reason: string }[]} */
  const failures = [];

  if (byId.size === 0) {
    if (draftAssertsProjectFacts(draftAnswer)) {
      return {
        result: 'abstain',
        failures: [{ claim: 'draft', reason: 'empty_evidence_with_project_claims' }],
        citedEvidenceIds: uniqueCited,
      };
    }
    return { result: 'pass', failures: [], citedEvidenceIds: uniqueCited };
  }

  for (const evidenceId of uniqueCited) {
    const record = byId.get(evidenceId);
    if (!record) {
      failures.push({ claim: evidenceId, reason: 'unknown_evidence_id' });
      continue;
    }
    if (knowledgeVersionId && record.knowledgeVersionId && String(record.knowledgeVersionId) !== knowledgeVersionId) {
      failures.push({ claim: evidenceId, reason: 'cross_version_evidence' });
    }
    if (record.path != null && String(record.path).trim() === '') {
      failures.push({ claim: evidenceId, reason: 'missing_path' });
    }
  }

  if (failures.length > 0) {
    return { result: 'fail', failures, citedEvidenceIds: uniqueCited };
  }

  if (uniqueCited.length === 0 && draftAssertsProjectFacts(draftAnswer)) {
    return {
      result: 'ambiguous',
      failures: [{ claim: 'draft', reason: 'project_claims_without_citations' }],
      citedEvidenceIds: uniqueCited,
    };
  }

  return { result: 'pass', failures: [], citedEvidenceIds: uniqueCited };
}

/**
 * @param {string} draftAnswer Draft text.
 * @returns {boolean}
 */
function draftAssertsProjectFacts(draftAnswer) {
  const text = String(draftAnswer ?? '').trim();
  if (text.length < 20) {
    return false;
  }
  if (/insufficient|do not have enough|cannot (?:find|determine)|not enough evidence/i.test(text)) {
    return false;
  }
  return PROJECT_CLAIM_PATTERN.test(text) || text.split(/\s+/).length >= 12;
}

/**
 * Optional budgeted LLM VERIFY for unresolved ambiguous claims.
 * @param {object} state Graph state.
 * @param {string} draftAnswer Draft text.
 * @param {object[]} toolResults Evidence.
 * @returns {Promise<object | null>}
 */
async function requestLlmVerifyDecision(state, draftAnswer, toolResults) {
  const evidenceSummary = toolResults.map((record) => ({
    evidenceId: record.evidenceId,
    path: record.path ?? null,
    knowledgeVersionId: record.knowledgeVersionId ?? null,
  }));
  try {
    const result = await generateText({
      purpose: 'verify',
      enableThinking: true,
      segments: [
        {
          id: 'system_verify',
          kind: 'system',
          content:
            'Check whether every non-trivial project claim in the draft is supported by the listed evidence ids. ' +
            'Return JSON only: result pass|fail|partial|abstain and optional failures[{claim,reason}]. No chain-of-thought.',
          protected: true,
        },
        {
          id: 'draft',
          kind: 'turn',
          role: 'assistant',
          content: draftAnswer,
        },
        {
          id: 'evidence',
          kind: 'turn',
          role: 'user',
          content: JSON.stringify(evidenceSummary),
        },
      ],
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['result'],
        properties: {
          result: { type: 'string', enum: ['pass', 'fail', 'partial', 'abstain'] },
          failures: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claim', 'reason'],
              properties: {
                claim: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      abortSignal: state.scope?.abortSignal,
    });
    let raw;
    try {
      raw = JSON.parse(typeof result.text === 'string' && result.text !== '' ? result.text : 'null');
    } catch {
      return null;
    }
    const parsed = verifyLlmDecisionSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    return { ...parsed.data, usage: result.usage };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONTEXT_ACCOUNTING_UNAVAILABLE') {
      throw error;
    }
    return null;
  }
}

/**
 * Maps VERIFY outcome onto supportLevel / revise / abstain routing fields.
 * @param {object} state Graph state.
 * @param {object} verifyResult Verify payload.
 * @param {string[]} stages Stage trace.
 * @param {object} tokenUpdate Budget token patch.
 * @param {object} callUpdate Budget call patch.
 * @param {object | null} llmUsage Optional verify usage.
 * @returns {object}
 */
function finishVerifyState(state, verifyResult, stages, tokenUpdate, callUpdate, llmUsage) {
  const reviseCount = state.reviseCount ?? 0;
  let result = verifyResult.result;
  let supportLevel = mapVerifyResultToSupportLevel(result, 'evidence_backed');

  if (result === 'fail') {
    if (reviseCount < MAX_VERIFY_REVISE) {
      result = 'revise';
    } else {
      const hasAnyEvidence = (state.toolResults ?? []).length > 0;
      result = hasAnyEvidence ? 'partial' : 'abstain';
      supportLevel = hasAnyEvidence ? 'partial' : 'insufficient';
    }
  } else if (result === 'ambiguous') {
    result = reviseCount < MAX_VERIFY_REVISE ? 'revise' : 'abstain';
    supportLevel = 'insufficient';
  } else {
    supportLevel = mapVerifyResultToSupportLevel(result, supportLevel);
  }

  return {
    verifyResult: { ...verifyResult, result },
    supportLevel,
    stages,
    reviseCount: result === 'revise' ? reviseCount + 1 : reviseCount,
    retrievalComplete: result === 'revise' ? false : state.retrievalComplete,
    budgetExhausted: result === 'revise' ? false : state.budgetExhausted,
    toolStop: result === 'revise' ? null : state.toolStop,
    verifyUsage: llmUsage,
    ...tokenUpdate,
    ...callUpdate,
  };
}

/**
 * @param {string | undefined} result Verify result.
 * @param {string} fallback Default support level.
 * @returns {string}
 */
function mapVerifyResultToSupportLevel(result, fallback) {
  if (result === 'pass') {
    return 'evidence_backed';
  }
  if (result === 'partial') {
    return 'partial';
  }
  if (result === 'abstain') {
    return 'insufficient';
  }
  if (result === 'fail') {
    return 'conflict';
  }
  return fallback;
}

/**
 * @param {object} state Graph state.
 * @returns {string}
 */
function buildAbstainContent(state) {
  const reason = state.verifyResult?.failures?.[0]?.reason;
  if (reason === 'empty_evidence_with_project_claims' || (state.toolResults ?? []).length === 0) {
    return 'I do not have enough project evidence to answer that confidently. Please refine the question or ensure relevant sources are indexed.';
  }
  return 'I could not verify the draft against project evidence, so I am abstaining rather than inventing project facts.';
}

/**
 * @param {string} content Body.
 * @returns {string}
 */
function appendPartialWarning(content) {
  if (/partially grounded|could not fully verify/i.test(content)) {
    return content;
  }
  return `${content.trim()}\n\n_Note: This answer is partially grounded; some claims could not be fully verified against evidence._`;
}

/**
 * @param {string} content Body.
 * @param {string | undefined} knowledgeHealth Scope health.
 * @returns {string}
 */
function appendPartialKnowledgeWarning(content, knowledgeHealth) {
  if (knowledgeHealth !== 'partially_available') {
    return content;
  }
  if (/partial knowledge|partially available/i.test(content)) {
    return content;
  }
  return `${content.trim()}\n\n_Project knowledge is only partially available; some sources may be missing._`;
}

/**
 * @param {object} state Graph state.
 * @returns {number | null}
 */
function resolveRunDurationMs(state) {
  if (Number.isFinite(state.draftDurationMs)) {
    return state.draftDurationMs;
  }
  if (typeof state.startedAt === 'string') {
    const started = Date.parse(state.startedAt);
    if (Number.isFinite(started)) {
      return Date.now() - started;
    }
  }
  return null;
}

/**
 * @param {object} state Graph state.
 * @returns {object | null}
 */
function mergeUsage(state) {
  const draft = state.draftUsage;
  if (!draft && !Number.isFinite(state.cumulativeInputTokens) && !Number.isFinite(state.cumulativeOutputTokens)) {
    return null;
  }
  const inputTokens = Number.isFinite(draft?.inputTokens)
    ? draft.inputTokens
    : Number.isFinite(state.cumulativeInputTokens)
      ? state.cumulativeInputTokens
      : null;
  const outputTokens = Number.isFinite(draft?.outputTokens)
    ? draft.outputTokens
    : Number.isFinite(state.cumulativeOutputTokens)
      ? state.cumulativeOutputTokens
      : null;
  if (inputTokens == null && outputTokens == null && draft?.totalTokens == null) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: draft?.totalTokens ?? null,
  };
}

/**
 * @param {string[] | undefined} stages Prior stages.
 * @param {string} stage Next stage.
 * @returns {string[]}
 */
function appendStage(stages, stage) {
  return [...(Array.isArray(stages) ? stages : []), stage];
}

/**
 * @param {(event: { stage: string, data?: object }) => void} onStage Hook.
 * @param {string} stage Stage name.
 * @returns {void}
 */
function fireSafeHook(onStage, stage) {
  try {
    onStage({ stage });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'chat graph stage hook failed', stage, ...caughtErrorFields(error) }));
  }
}

/**
 * @param {(text: string) => void} onDelta Hook.
 * @param {string} text Delta text.
 * @returns {void}
 */
function fireSafeDelta(onDelta, text) {
  try {
    onDelta(text);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'chat graph delta hook failed', ...caughtErrorFields(error) }));
  }
}

/**
 * @param {(evidence: object[]) => void} onEvidence Hook.
 * @param {object[]} evidence Evidence records.
 * @returns {void}
 */
function fireSafeEvidence(onEvidence, evidence) {
  try {
    onEvidence(evidence);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'chat graph evidence hook failed', ...caughtErrorFields(error) }));
  }
}

/**
 * @param {(payload: object) => void} onDone Hook.
 * @param {object} payload Done payload.
 * @returns {void}
 */
function fireSafeDone(onDone, payload) {
  try {
    onDone(payload);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'chat graph done hook failed', ...caughtErrorFields(error) }));
  }
}

/**
 * @param {(error: unknown) => void} onError Hook.
 * @param {unknown} error Failure.
 * @returns {void}
 */
function fireSafeError(onError, error) {
  try {
    onError(error);
  } catch (hookError) {
    console.error(JSON.stringify({ level: 'error', msg: 'chat graph error hook failed', ...caughtErrorFields(hookError) }));
  }
}

/**
 * Hydrates a Mongo row into a LangGraph CheckpointTuple.
 * @param {object} row Lean checkpoint document.
 * @param {object} serde Saver serializer.
 * @returns {Promise<object>}
 */
async function hydrateCheckpointTuple(row, serde) {
  const packed = row.checkpoint ?? {};
  const checkpoint = await serde.loadsTyped(packed.type ?? 'json', Buffer.from(String(packed.data ?? ''), 'base64'));
  const lgMeta = row.metadata?.langGraph;
  const metadata = lgMeta ? await serde.loadsTyped(lgMeta.type ?? 'json', Buffer.from(String(lgMeta.data ?? ''), 'base64')) : undefined;
  /** @type {Array<[string, string, unknown]> | undefined} */
  let pendingWrites;
  if (Array.isArray(row.metadata?.pendingWrites)) {
    pendingWrites = [];
    for (const write of row.metadata.pendingWrites) {
      const value = await serde.loadsTyped(write.type ?? 'json', Buffer.from(String(write.data ?? ''), 'base64'));
      pendingWrites.push([write.taskId, write.channel, value]);
    }
  }
  /** @type {object} */
  const tuple = {
    config: {
      configurable: {
        thread_id: row.threadId,
        checkpoint_ns: row.checkpointNs ?? '',
        checkpoint_id: row.checkpointId,
        org_id: String(row.orgId),
      },
    },
    checkpoint,
    metadata,
    pendingWrites,
  };
  if (row.parentCheckpointId) {
    tuple.parentConfig = {
      configurable: {
        thread_id: row.threadId,
        checkpoint_ns: row.checkpointNs ?? '',
        checkpoint_id: row.parentCheckpointId,
        org_id: String(row.orgId),
      },
    };
  }
  return tuple;
}
