/**
 * Conversation context — extractive summary, pinned facts, measured metrics,
 * and the Mongo loader Phase 47 calls before `prepareModelInput`. No LLM.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { PINNED_FACT_SOURCE_VALUES } from '../../models/conversations.model.js';
import { Message } from '../../models/messages.model.js';
import { ApiError } from '../../platform/errors.js';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import mongoose from 'mongoose';
import { z } from 'zod';
import { listRecentMessages } from './conversation.helper.js';
import { assertConversationWritable, loadConversationForUser } from './conversation.js';

/** Cap on protected pins stored on one conversation. */
export const PINNED_FACTS_MAX_COUNT = 20;

/** Loader safety cap before the budgeter measures the assembled prompt. */
export const RECENT_TURNS_MAX_COUNT = 50;

/** Truncate extractive summary text rather than fail the run. */
export const SUMMARY_TEXT_MAX_CHARS = 4000;

const conversationParamsSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
});

/**
 * Assembles summary + pins + recent turns for `prepareModelInput`.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {{ actorUserId: string, budgetHint?: number }} options Owner + optional turn cap.
 * @returns {Promise<{
 *   segments: object[],
 *   summarySegment: object | undefined,
 *   pinnedSegments: object[],
 *   recentMessageIds: string[],
 * }>}
 * @throws {import('../../platform/errors.js').ApiError} CONVERSATION_NOT_FOUND
 */
export async function buildConversationContext(orgId, projectId, conversationId, options) {
  const conversation = await loadConversationForUser(orgId, projectId, conversationId, options.actorUserId);
  const stored = readConversationContext(conversation);
  const turnLimit =
    Number.isFinite(options.budgetHint) && options.budgetHint > 0 ? Math.min(options.budgetHint, RECENT_TURNS_MAX_COUNT) : RECENT_TURNS_MAX_COUNT;
  const recent = await listRecentMessages(orgId, projectId, conversationId, turnLimit);
  const summarySegment = stored.summaryText ? { id: 'summary', kind: 'summary', content: stored.summaryText } : undefined;
  const pinnedSegments = buildPinnedSegments(stored.pinnedFacts);
  /** @type {object[]} */
  const segments = [];
  if (summarySegment) {
    segments.push(summarySegment);
  }
  segments.push(...pinnedSegments);
  /** @type {string[]} */
  const recentMessageIds = [];
  for (const message of recent) {
    const messageId = String(message._id ?? message.id);
    recentMessageIds.push(messageId);
    segments.push({
      id: `turn:${messageId}`,
      kind: 'turn',
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
    });
  }
  return { segments, summarySegment, pinnedSegments, recentMessageIds };

  /**
   * Builds protected pinned-fact segments for the budgeter.
   * @param {object[]} pinnedFacts Stored pins.
   * @returns {{ id: string, kind: string, content: string, protected: true }[]}
   */
  function buildPinnedSegments(pinnedFacts) {
    /** @type {{ id: string, kind: string, content: string, protected: true }[]} */
    const pinSegments = [];
    for (const fact of pinnedFacts) {
      const factId = typeof fact?.id === 'string' ? fact.id : '';
      if (!factId) {
        continue;
      }
      pinSegments.push({
        id: `pin:${factId}`,
        kind: 'pinned_fact',
        content: typeof fact.text === 'string' ? fact.text : '',
        protected: true,
      });
    }
    return pinSegments;
  }
}

/**
 * Refreshes the extractive summary from user questions through a message id.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} actorUserId Owner user id.
 * @param {{ throughMessageId: string }} input Cover cursor.
 * @returns {Promise<void>}
 * @throws {import('../../platform/errors.js').ApiError}
 */
export async function updateConversationSummary(orgId, projectId, conversationId, actorUserId, input) {
  const conversation = await loadConversationForUser(orgId, projectId, conversationId, actorUserId);
  assertConversationWritable(conversation, actorUserId);
  const covered = await loadMessagesThroughId(orgId, projectId, conversationId, input.throughMessageId);
  const summaryText = buildExtractiveSummaryText(covered);
  conversation.set('context.summaryText', summaryText);
  conversation.set('context.summaryUpdatedAt', new Date());
  conversation.set('context.summaryCoversThroughMessageId', new mongoose.Types.ObjectId(String(input.throughMessageId)));
  conversation.updatedBy = actorUserId;
  await conversation.save();

  /**
   * Concatenates user-question text through `throughMessageId` and truncates.
   * @param {object[]} messages Chronological active messages through the cover id.
   * @returns {string}
   */
  function buildExtractiveSummaryText(messages) {
    /** @type {string[]} */
    const pieces = [];
    for (const message of messages) {
      if (message.role !== 'user') {
        continue;
      }
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (content) {
        pieces.push(content);
      }
    }
    const joined = pieces.join('\n');
    if (joined.length <= SUMMARY_TEXT_MAX_CHARS) {
      return joined;
    }
    return joined.slice(0, SUMMARY_TEXT_MAX_CHARS);
  }

  /**
   * Loads active messages up to and including `throughMessageId`.
   * @param {string} tenantOrgId Tenant id.
   * @param {string} tenantProjectId Project id.
   * @param {string} tenantConversationId Conversation id.
   * @param {string} throughMessageId Last covered message id.
   * @returns {Promise<object[]>}
   * @throws {import('../../platform/errors.js').ApiError} VALIDATION_ERROR
   */
  async function loadMessagesThroughId(tenantOrgId, tenantProjectId, tenantConversationId, throughMessageId) {
    if (!mongoose.isValidObjectId(throughMessageId)) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'throughMessageId', message: 'throughMessageId must be a valid ObjectId' }],
      });
    }
    const throughId = new mongoose.Types.ObjectId(String(throughMessageId));
    const through = await Message.findOne({
      _id: throughId,
      orgId: tenantOrgId,
      projectId: new mongoose.Types.ObjectId(String(tenantProjectId)),
      conversationId: new mongoose.Types.ObjectId(String(tenantConversationId)),
      status: ROW_STATUS_ACTIVE,
    })
      .lean()
      .exec();
    if (!through) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'throughMessageId', message: 'throughMessageId is not in this conversation' }],
      });
    }
    return Message.find({
      orgId: tenantOrgId,
      projectId: new mongoose.Types.ObjectId(String(tenantProjectId)),
      conversationId: new mongoose.Types.ObjectId(String(tenantConversationId)),
      status: ROW_STATUS_ACTIVE,
      $or: [{ createdAt: { $lt: through.createdAt } }, { createdAt: through.createdAt, _id: { $lte: throughId } }],
    })
      .sort({ createdAt: 1, _id: 1 })
      .select({ role: 1, content: 1 })
      .lean()
      .exec();
  }
}

/**
 * Updates the extractive summary only when the budgeter replaced turns.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} actorUserId Owner user id.
 * @param {{ throughMessageId: string, compactionActions?: object[] }} input Budgeter result.
 * @returns {Promise<void>}
 */
export async function applySummaryFromCompaction(orgId, projectId, conversationId, actorUserId, input) {
  const actions = Array.isArray(input.compactionActions) ? input.compactionActions : [];
  const replaced = actions.some((action) => action?.action === 'replace_with_summary');
  if (!replaced) {
    return;
  }
  await updateConversationSummary(orgId, projectId, conversationId, actorUserId, {
    throughMessageId: input.throughMessageId,
  });
}

/**
 * Pins a fact for later protected segments. Internal — no HTTP in this phase.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} actorUserId Owner user id.
 * @param {{ id: string, text: string, source: string, messageId?: string }} fact Pin payload.
 * @returns {Promise<void>}
 * @throws {import('../../platform/errors.js').ApiError}
 */
export async function pinFact(orgId, projectId, conversationId, actorUserId, fact) {
  const conversation = await loadConversationForUser(orgId, projectId, conversationId, actorUserId);
  assertConversationWritable(conversation, actorUserId);
  const factId = typeof fact?.id === 'string' ? fact.id.trim() : '';
  const text = typeof fact?.text === 'string' ? fact.text.trim() : '';
  const source = typeof fact?.source === 'string' ? fact.source : '';
  if (!factId || !text || !PINNED_FACT_SOURCE_VALUES.includes(source)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'fact', message: 'id, text, and source are required' }],
    });
  }
  const stored = readConversationContext(conversation);
  if (stored.pinnedFacts.some((existing) => existing.id === factId)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'fact.id', message: 'duplicate pin id' }],
    });
  }
  if (stored.pinnedFacts.length >= PINNED_FACTS_MAX_COUNT) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'fact', message: 'pinned facts cap reached' }],
    });
  }
  let messageId = null;
  if (fact.messageId) {
    if (!mongoose.isValidObjectId(fact.messageId)) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'fact.messageId', message: 'messageId must be a valid ObjectId' }],
      });
    }
    messageId = new mongoose.Types.ObjectId(String(fact.messageId));
  }
  stored.pinnedFacts.push({
    id: factId,
    text,
    source,
    messageId,
    createdAt: new Date(),
  });
  conversation.set('context.pinnedFacts', stored.pinnedFacts);
  conversation.updatedBy = actorUserId;
  await conversation.save();
}

/**
 * Removes a pinned fact by caller-supplied id.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} actorUserId Owner user id.
 * @param {string} factId Pin id.
 * @returns {Promise<void>}
 * @throws {import('../../platform/errors.js').ApiError}
 */
export async function unpinFact(orgId, projectId, conversationId, actorUserId, factId) {
  const conversation = await loadConversationForUser(orgId, projectId, conversationId, actorUserId);
  assertConversationWritable(conversation, actorUserId);
  const pinId = typeof factId === 'string' ? factId.trim() : '';
  if (!pinId) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'factId', message: 'factId is required' }],
    });
  }
  const stored = readConversationContext(conversation);
  const nextFacts = stored.pinnedFacts.filter((existing) => existing.id !== pinId);
  if (nextFacts.length === stored.pinnedFacts.length) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'factId', message: 'pin id not found' }],
    });
  }
  conversation.set('context.pinnedFacts', nextFacts);
  conversation.updatedBy = actorUserId;
  await conversation.save();
}

/**
 * Writes measured budgeter counts onto an assistant message. No-ops when
 * accounting failed so the UI never sees a partial or guessed object.
 * @param {string} messageId Assistant message id.
 * @param {object | null | undefined} prepareModelInputOutput Phase 43 return value.
 * @returns {Promise<void>}
 * @throws {import('../../platform/errors.js').ApiError}
 */
export async function persistMessageContextMetrics(messageId, prepareModelInputOutput) {
  const metrics = buildContextMetricsFromBudgeter(prepareModelInputOutput);
  if (!metrics) {
    return;
  }
  if (!mongoose.isValidObjectId(messageId)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'messageId', message: 'messageId must be a valid ObjectId' }],
    });
  }
  const updated = await Message.updateOne(
    {
      _id: new mongoose.Types.ObjectId(String(messageId)),
      role: 'assistant',
      status: ROW_STATUS_ACTIVE,
    },
    { $set: { contextMetrics: metrics } },
  );
  if (updated.matchedCount === 0) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }

  /**
   * Builds a persistable metrics object from a successful `prepareModelInput` result.
   * @param {object | null | undefined} budgeterOutput Phase 43 return value.
   * @returns {object | null}
   */
  function buildContextMetricsFromBudgeter(budgeterOutput) {
    if (!Number.isFinite(budgeterOutput?.measuredInputTokens) || !Number.isFinite(budgeterOutput?.validatedContextCapacity)) {
      return null;
    }
    /** @type {Record<string, unknown>} */
    const nextMetrics = {
      validatedContextCapacity: budgeterOutput.validatedContextCapacity,
      measuredInputTokens: budgeterOutput.measuredInputTokens,
    };
    if (Number.isFinite(budgeterOutput.maximumInputBudget)) {
      nextMetrics.maximumInputBudget = budgeterOutput.maximumInputBudget;
    }
    if (Number.isFinite(budgeterOutput.reservedOutputTokens)) {
      nextMetrics.reservedOutputTokens = budgeterOutput.reservedOutputTokens;
    }
    if (Array.isArray(budgeterOutput.compactionActions)) {
      nextMetrics.compactionActions = budgeterOutput.compactionActions;
    }
    if (Number.isFinite(budgeterOutput.maximumInputBudget) && budgeterOutput.maximumInputBudget > 0) {
      nextMetrics.contextPercentUsed = budgeterOutput.measuredInputTokens / budgeterOutput.maximumInputBudget;
    }
    return nextMetrics;
  }
}

/**
 * Read-only context view for UI warnings (frontend §37).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} actorUserId Owner user id.
 * @returns {Promise<object>}
 * @throws {import('../../platform/errors.js').ApiError} CONVERSATION_NOT_FOUND
 */
export async function getConversationContextView(orgId, projectId, conversationId, actorUserId) {
  const conversation = await loadConversationForUser(orgId, projectId, conversationId, actorUserId);
  const stored = readConversationContext(conversation);
  /** @type {Record<string, unknown>} */
  const body = {
    summaryPresent: stored.summaryText.length > 0,
    pinnedFactCount: stored.pinnedFacts.length,
  };
  if (stored.summaryUpdatedAt) {
    const stamp = stored.summaryUpdatedAt;
    body.summaryUpdatedAt = stamp instanceof Date ? stamp.toISOString() : String(stamp);
  }
  const latest = await Message.findOne({
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    conversationId: new mongoose.Types.ObjectId(String(conversationId)),
    role: 'assistant',
    status: ROW_STATUS_ACTIVE,
    contextMetrics: { $ne: null },
  })
    .sort({ createdAt: -1, _id: -1 })
    .select({ contextMetrics: 1 })
    .lean()
    .exec();
  if (latest?.contextMetrics && typeof latest.contextMetrics === 'object') {
    const lastRunMetrics = mapLastRunMetrics(latest.contextMetrics);
    if (lastRunMetrics) {
      body.lastRunMetrics = lastRunMetrics;
    }
  }
  return body;

  /**
   * Copies last-run metrics for GET context, omitting unavailable keys.
   * @param {object} storedMetrics Persisted `contextMetrics`.
   * @returns {object | undefined}
   */
  function mapLastRunMetrics(storedMetrics) {
    /** @type {Record<string, number>} */
    const lastRunMetrics = {};
    if (Number.isFinite(storedMetrics.measuredInputTokens)) {
      lastRunMetrics.measuredInputTokens = storedMetrics.measuredInputTokens;
    }
    if (Number.isFinite(storedMetrics.maximumInputBudget)) {
      lastRunMetrics.maximumInputBudget = storedMetrics.maximumInputBudget;
    }
    if (Number.isFinite(storedMetrics.contextPercentUsed)) {
      lastRunMetrics.contextPercentUsed = storedMetrics.contextPercentUsed;
    }
    return Object.keys(lastRunMetrics).length > 0 ? lastRunMetrics : undefined;
  }
}

/**
 * Registers GET `.../conversations/:conversationId/context`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function conversationContextRoutes(app) {
  const askPreHandler = requireProjectPermission('chat.ask');
  app.get(
    '/projects/:projectId/conversations/:conversationId/context',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: askPreHandler,
    },
    async (request, reply) => {
      const params = parseConversationParams(request.params);
      const scope = request.projectScope;
      const body = await getConversationContextView(scope.orgId, scope.projectId, params.conversationId, scope.userId);
      return reply.send(body);
    },
  );

  /**
   * Parses conversation params or throws VALIDATION_ERROR.
   * @param {unknown} params Route params.
   * @returns {{ projectId: string, conversationId: string }}
   */
  function parseConversationParams(params) {
    const parsed = conversationParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }
}

/**
 * Reads the nested context bag, treating missing documents as empty.
 * Shared by several conversation-context writers and readers.
 * @param {object | null | undefined} conversation Conversation row.
 * @returns {{
 *   summaryText: string,
 *   summaryUpdatedAt: Date | null,
 *   summaryCoversThroughMessageId: import('mongoose').Types.ObjectId | null,
 *   pinnedFacts: object[],
 * }}
 */
function readConversationContext(conversation) {
  const stored = conversation?.context;
  return {
    summaryText: typeof stored?.summaryText === 'string' ? stored.summaryText : '',
    summaryUpdatedAt: stored?.summaryUpdatedAt instanceof Date ? stored.summaryUpdatedAt : (stored?.summaryUpdatedAt ?? null),
    summaryCoversThroughMessageId: stored?.summaryCoversThroughMessageId ?? null,
    pinnedFacts: Array.isArray(stored?.pinnedFacts) ? stored.pinnedFacts : [],
  };
}
