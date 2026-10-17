/**
 * Chat message SSE transport — POST ask with Accept: text/event-stream,
 * knowledge gate, queued 202 when updating, edit/retry resubmit, and LangGraph hooks.
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { findProjectById } from '../masters/index.js';
import { assertKnowledgeReadable } from '../knowledge/index.js';
import { buildStreamErrorEvent } from '../../platform/streamErrors.js';
import { completeIdempotencyRecord } from '../../platform/idempotency/index.js';
import { buildAuditContextFromRequest, recordAuditEvent } from '../access/index.js';
import { ApiError, caughtErrorFields, canSendJsonError } from '../../platform/errors.js';
import { invokeChatGraph, buildChatGraphThreadId, createMongoChatCheckpointer } from './chatGraph.js';
import { enqueueChatMessageWhileKnowledgeUpdating, QUEUED_MESSAGE_TTL_MS, resolveWriterJobId } from './chatQueue.js';
import { assertConversationWritable, loadConversationForUser, refreshConversationSearchText } from './conversation.js';
import { persistOpenClarificationSetFromInterrupt, supersedeOpenClarificationSetsForMessages } from './clarification.js';
import {
  insertChatTurnPair,
  markUserMessageQueued,
  softDeleteMessagesAfter,
  softDeleteActiveMessageById,
  insertAssistantForExistingUser,
  findActiveMessageInConversation,
  updateUserMessageContentForEdit,
  conversationHasInFlightChatMessage,
  findLatestActiveMessageInConversation,
  finalizeAssistantMessage as finalizeAssistantMessageInRepo,
} from './conversation.helper.js';

/** Echoed on SSE responses (same as HTTP `X-Correlation-Id`). */
const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Max user question length for POST messages (named constant, not env). */
export const CHAT_MESSAGE_CONTENT_MAX_LENGTH = 16_000;

/** SSE comment keepalive interval while the stream is open. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Assistant `messageStatus` values that allow user-initiated retry. */
const MESSAGE_RETRY_ALLOWED_STATUSES = Object.freeze(['failed', 'interrupted']);

const conversationParamsSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
});

const messageParamsSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});

const askBodySchema = z
  .object({
    content: z.string().trim().min(1).max(CHAT_MESSAGE_CONTENT_MAX_LENGTH),
  })
  .strict();

/**
 * POST /conversation/chatStream/streamMessage/:projectId/:conversationId — grounded chat SSE or 202 queue.
 * @param {import('fastify').FastifyRequest} request Request with projectScope and Accept stream.
 * @param {import('fastify').FastifyReply} reply Hijacked for SSE, or JSON 202 / errors.
 */
export async function streamConversationMessageHttp(request, reply) {
  const params = conversationParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  const parsed = askBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }

  const scope = request.projectScope;
  const audit = buildAuditContextFromRequest(request);
  const correlationId = audit.correlationId ?? request.id;

  const conversation = await loadConversationForUser(scope.orgId, scope.projectId, params.data.conversationId, scope.userId);
  assertConversationWritable(conversation, scope.userId);

  const gate = await assertKnowledgeReadable({ orgId: scope.orgId, projectId: scope.projectId });
  if (gate.action === 'deny') {
    throw ApiError.fromCode(gate.code ?? 'KNOWLEDGE_UNAVAILABLE');
  }

  if (gate.action === 'queue') {
    const queued = await enqueueChatMessageWhileKnowledgeUpdating({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: params.data.conversationId,
      actorUserId: scope.userId,
      content: parsed.data.content,
    });
    await recordAuditEvent(
      {
        orgId: scope.orgId,
        actorUserId: scope.userId,
        action: 'chat.message_queued',
        resourceType: 'conversation',
        resourceId: params.data.conversationId,
        result: 'success',
        correlationId,
        ip: audit.ip,
        userAgent: audit.userAgent,
        context: {
          messageId: queued.messageId,
          jobId: queued.jobId,
          projectId: String(scope.projectId),
        },
      },
      { log: request.log },
    );
    await completeChatIdempotency(request, queued, 202);
    return reply.code(202).send(queued);
  }

  if (!acceptIncludesEventStream(request.headers.accept)) {
    throw ApiError.fromCode('NOT_ACCEPTABLE');
  }

  /** @type {boolean} */
  let clientConnected = true;
  const runAbort = new AbortController();
  const onClose = () => {
    clientConnected = false;
    if (!runAbort.signal.aborted) {
      runAbort.abort();
    }
  };
  request.raw.on('close', onClose);

  /** @type {ReturnType<typeof setInterval> | null} */
  let keepaliveTimer = null;
  /** @type {boolean} */
  let headersOpened = false;

  /**
   * Writes one SSE event when the client is still connected.
   * @param {string} event Event name.
   * @param {unknown} data JSON-serializable payload.
   */
  function writeSse(event, data) {
    if (!clientConnected || !headersOpened) {
      return;
    }
    try {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      clientConnected = false;
      request.log?.warn?.({ ...caughtErrorFields(error) }, 'sse write failed');
    }
  }

  try {
    const outcome = await runChatMessageStream({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: params.data.conversationId,
      actorUserId: scope.userId,
      content: parsed.data.content,
      correlationId,
      workspaceRoot: request.server.config.workspace.root,
      log: request.log,
      gate,
      skipConversationLoad: true,
      abortSignal: runAbort.signal,
      isClientConnected: () => clientConnected,
      openSse: () => {
        if (headersOpened) {
          return;
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          [CORRELATION_ID_HEADER]: correlationId,
        });
        headersOpened = true;
        keepaliveTimer = setInterval(() => {
          if (!clientConnected || !headersOpened) {
            return;
          }
          try {
            reply.raw.write(': keepalive\n\n');
          } catch {
            clientConnected = false;
          }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        if (typeof keepaliveTimer.unref === 'function') {
          keepaliveTimer.unref();
        }
      },
      writeSse,
    });

    await completeChatIdempotency(request, {
      userMessageId: outcome.userMessageId,
      assistantMessageId: outcome.assistantMessageId,
      messageStatus: outcome.messageStatus,
    });

    if (headersOpened) {
      reply.raw.end();
    }
  } catch (error) {
    request.log?.error?.({ ...caughtErrorFields(error), headersOpened }, 'chat stream request failed');
    if (headersOpened) {
      const frame = buildStreamErrorEvent(error, correlationId);
      writeSse(frame.event, frame.data);
      try {
        await completeChatIdempotency(request, {
          userMessageId: null,
          assistantMessageId: null,
          messageStatus: 'failed',
        });
      } catch (idempotencyError) {
        request.log?.error?.({ ...caughtErrorFields(idempotencyError) }, 'chat stream idempotency complete failed after SSE error');
      }
      reply.raw.end();
      return;
    }
    if (!canSendJsonError(reply)) {
      request.log?.error?.({ ...caughtErrorFields(error) }, 'chat stream failed after headers');
      return;
    }
    throw error;
  } finally {
    request.raw.off('close', onClose);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
    }
  }
}

/**
 * Orchestrates allow-path insert → graph → SSE hooks. Never receives `reply`.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   content: string,
 *   correlationId: string,
 *   workspaceRoot: string,
 *   log?: import('fastify').FastifyBaseLogger,
 *   gate?: { action: string, knowledgeVersionId?: string, code?: string },
 *   skipConversationLoad?: boolean,
 *   abortSignal?: AbortSignal,
 *   isClientConnected: () => boolean,
 *   openSse: () => void,
 *   writeSse: (event: string, data: unknown) => void,
 * }} input Stream inputs.
 * @returns {Promise<{ userMessageId: string, assistantMessageId: string, messageStatus: string }>}
 */
export async function runChatMessageStream(input) {
  if (!input.skipConversationLoad) {
    const conversation = await loadConversationForUser(input.orgId, input.projectId, input.conversationId, input.actorUserId);
    assertConversationWritable(conversation, input.actorUserId);
  }

  const gate = input.gate ?? (await assertKnowledgeReadable({ orgId: input.orgId, projectId: input.projectId }));
  if (gate.action === 'deny') {
    throw ApiError.fromCode(gate.code ?? 'KNOWLEDGE_UNAVAILABLE');
  }
  if (gate.action === 'queue') {
    // Unit-test / direct callers still get the catalog code; HTTP path returns 202 above.
    throw ApiError.fromCode('KNOWLEDGE_UPDATING');
  }

  const pair = await insertChatTurnPair({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
    content: input.content,
    knowledgeVersionId: gate.knowledgeVersionId ?? null,
  });

  return runChatStreamForExistingUser({
    ...input,
    gate,
    userMessageId: String(pair.userMessage._id),
    assistantMessageId: String(pair.assistantMessage._id),
    content: input.content,
    removedMessageIds: [],
  });
}

/**
 * Runs FLOW B SSE for an existing user message and pending assistant row. Never receives `reply`.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   userMessageId: string,
 *   assistantMessageId: string,
 *   content: string,
 *   correlationId: string,
 *   workspaceRoot: string,
 *   log?: import('fastify').FastifyBaseLogger,
 *   gate?: { action: string, knowledgeVersionId?: string, code?: string },
 *   removedMessageIds?: string[],
 *   editGeneration?: number,
 *   abortSignal?: AbortSignal,
 *   isClientConnected: () => boolean,
 *   openSse: () => void,
 *   writeSse: (event: string, data: unknown) => void,
 * }} input Stream inputs for an already-persisted turn pair.
 * @returns {Promise<{
 *   userMessageId: string,
 *   assistantMessageId: string,
 *   messageStatus: string,
 *   removedMessageIds: string[],
 *   editGeneration?: number,
 * }>}
 */
export async function runChatStreamForExistingUser(input) {
  const gate = input.gate ?? (await assertKnowledgeReadable({ orgId: input.orgId, projectId: input.projectId }));
  if (gate.action === 'deny') {
    throw ApiError.fromCode(gate.code ?? 'KNOWLEDGE_UNAVAILABLE');
  }
  if (gate.action === 'queue') {
    throw ApiError.fromCode('KNOWLEDGE_UPDATING');
  }

  const project = await findProjectById(input.orgId, input.projectId);
  const knowledgeHealth = typeof project?.knowledgeHealth === 'string' ? project.knowledgeHealth : undefined;
  const userMessageId = String(input.userMessageId);
  const assistantMessageId = String(input.assistantMessageId);
  const removedMessageIds = Array.isArray(input.removedMessageIds) ? input.removedMessageIds : [];

  input.openSse();
  input.writeSse('status', {
    stage: 'accepted',
    ...(knowledgeHealth ? { knowledgeHealth } : {}),
    ...(removedMessageIds.length > 0 ? { removedMessageIds } : {}),
    ...(typeof input.editGeneration === 'number' ? { editGeneration: input.editGeneration } : {}),
  });

  const threadId = buildChatGraphThreadId(input.orgId, input.conversationId, assistantMessageId);
  const checkpointer = createMongoChatCheckpointer();

  /** @type {string} */
  let terminalStatus = 'completed';
  /** @type {boolean} */
  let sawDone = false;
  /** @type {string} */
  let streamedContent = '';

  try {
    const result = await invokeChatGraph({
      threadId,
      checkpointer,
      input: {
        scope: {
          orgId: input.orgId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          userId: input.actorUserId,
          userMessageId,
          assistantMessageId,
          knowledgeVersionId: gate.knowledgeVersionId ? String(gate.knowledgeVersionId) : null,
          correlationId: input.correlationId,
          workspaceRoot: input.workspaceRoot,
          abortSignal: input.abortSignal,
        },
        question: input.content,
      },
      onStage: (event) => {
        if (!input.isClientConnected()) {
          return;
        }
        // Status frames carry stage only — never CoT or clarify payloads.
        input.writeSse('status', { stage: event.stage });
      },
      onDelta: (text) => {
        if (typeof text === 'string' && text.length > 0) {
          streamedContent += text;
        }
        if (!input.isClientConnected()) {
          return;
        }
        if (typeof text === 'string' && text.length > 0) {
          input.writeSse('delta', { text });
        }
      },
      onEvidence: (items) => {
        if (!input.isClientConnected()) {
          return;
        }
        input.writeSse('evidence', { items: Array.isArray(items) ? items : [] });
      },
      onDone: (payload) => {
        if (input.abortSignal?.aborted) {
          return;
        }
        sawDone = true;
        terminalStatus = 'completed';
        if (!input.isClientConnected()) {
          return;
        }
        input.writeSse('done', { messageId: String(payload?.messageId ?? assistantMessageId) });
      },
      onError: (error) => {
        if (isChatRunAbortError(error) || input.abortSignal?.aborted) {
          terminalStatus = 'interrupted';
          return;
        }
        terminalStatus = 'failed';
        if (!input.isClientConnected()) {
          return;
        }
        const frame = buildStreamErrorEvent(error, input.correlationId);
        input.writeSse(frame.event, frame.data);
      },
    });

    if (input.abortSignal?.aborted && !sawDone) {
      await finalizeAssistantMessageInRepo({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        assistantMessageId,
        content: streamedContent,
        messageStatus: 'interrupted',
        updatedBy: input.actorUserId,
      });
      return buildExistingUserStreamOutcome(input, userMessageId, assistantMessageId, 'interrupted', removedMessageIds);
    }

    if (result?.__interrupt__) {
      const clarificationSet = result.__interrupt__[0]?.value;
      terminalStatus = 'awaiting_clarification';
      if (clarificationSet) {
        await persistOpenClarificationSetFromInterrupt({
          orgId: input.orgId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          messageId: assistantMessageId,
          actorUserId: input.actorUserId,
          clarificationSet,
        });
      }
      await finalizeAssistantMessageInRepo({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        assistantMessageId,
        content: '',
        messageStatus: 'awaiting_clarification',
        updatedBy: input.actorUserId,
      });
      if (input.isClientConnected() && clarificationSet) {
        input.writeSse('clarification', {
          messageId: assistantMessageId,
          clarificationSetId: clarificationSet.clarificationSetId,
          roundIndex: clarificationSet.roundIndex ?? 0,
          questions: clarificationSet.questions ?? [],
        });
      }
      return buildExistingUserStreamOutcome(input, userMessageId, assistantMessageId, terminalStatus, removedMessageIds);
    }

    if (!sawDone && terminalStatus !== 'failed') {
      const row = await finalizeAssistantMessageInRepo({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        assistantMessageId,
        content: typeof result?.answerContent === 'string' ? result.answerContent : '',
        messageStatus: result?.supportLevel === 'insufficient' || result?.route === 'abstain_early' ? 'abstained' : 'completed',
        updatedBy: input.actorUserId,
      }).catch(() => null);
      if (row) {
        terminalStatus = row.messageStatus;
        if (input.isClientConnected()) {
          input.writeSse('done', { messageId: assistantMessageId });
        }
      }
    }

    return buildExistingUserStreamOutcome(input, userMessageId, assistantMessageId, terminalStatus, removedMessageIds);
  } catch (error) {
    const aborted = input.abortSignal?.aborted || isChatRunAbortError(error);
    terminalStatus = aborted ? 'interrupted' : 'failed';
    try {
      await finalizeAssistantMessageInRepo({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        assistantMessageId,
        content: aborted ? streamedContent : '',
        messageStatus: terminalStatus,
        updatedBy: input.actorUserId,
      });
    } catch (persistError) {
      input.log?.error?.(
        { ...caughtErrorFields(persistError) },
        aborted ? 'chat stream failed to mark assistant interrupted' : 'chat stream failed to mark assistant failed',
      );
    }
    if (aborted) {
      return buildExistingUserStreamOutcome(input, userMessageId, assistantMessageId, 'interrupted', removedMessageIds);
    }
    throw error;
  }
}

/**
 * POST /conversation/chatStream/editMessage/:projectId/:conversationId/:messageId — edit + replace downstream + SSE/202.
 * @param {import('fastify').FastifyRequest} request Request with projectScope.
 * @param {import('fastify').FastifyReply} reply SSE, JSON 200/202, or errors.
 */
export async function editConversationMessageHttp(request, reply) {
  const params = messageParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  const parsed = askBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }

  const scope = request.projectScope;
  const audit = buildAuditContextFromRequest(request);
  const correlationId = audit.correlationId ?? request.id;

  const conversation = await loadConversationForUser(scope.orgId, scope.projectId, params.data.conversationId, scope.userId);
  assertConversationWritable(conversation, scope.userId);

  const userMessage = await findActiveMessageInConversation({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    messageId: params.data.messageId,
  });
  if (!userMessage || userMessage.role !== 'user') {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  if (String(userMessage.createdBy) !== String(scope.userId)) {
    throw ApiError.fromCode('FORBIDDEN');
  }

  // Queued-only edit: update text in place, soft-delete any later rows, stay queued (no SSE).
  if (userMessage.messageStatus === 'queued') {
    const applied = await applyUserMessageEditReplaceDownstream({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: params.data.conversationId,
      messageId: params.data.messageId,
      content: parsed.data.content,
      actorUserId: scope.userId,
      afterCreatedAt: userMessage.createdAt,
    });
    const body = {
      userMessageId: String(applied.userMessage._id),
      assistantMessageId: null,
      messageStatus: 'queued',
      editGeneration: applied.userMessage.editGeneration ?? 0,
      removedMessageIds: applied.removedMessageIds,
      messageId: String(applied.userMessage._id),
      queuedAt: applied.userMessage.queuedAt ? new Date(applied.userMessage.queuedAt).toISOString() : undefined,
      expiresAt: applied.userMessage.expiresAt ? new Date(applied.userMessage.expiresAt).toISOString() : undefined,
      jobId: applied.userMessage.blockingJobId ? String(applied.userMessage.blockingJobId) : null,
    };
    await recordChatEditAudit(request, scope, params.data.conversationId, correlationId, audit, {
      messageId: body.userMessageId,
      removedMessageIds: body.removedMessageIds,
      editGeneration: body.editGeneration,
    });
    await completeChatIdempotency(request, body, 200);
    return reply.code(200).send(body);
  }

  if (
    await conversationHasInFlightChatMessage({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: params.data.conversationId,
    })
  ) {
    throw ApiError.fromCode('MESSAGE_NOT_EDITABLE');
  }

  const gate = await assertKnowledgeReadable({ orgId: scope.orgId, projectId: scope.projectId });
  if (gate.action === 'deny') {
    throw ApiError.fromCode(gate.code ?? 'KNOWLEDGE_UNAVAILABLE');
  }

  const applied = await applyUserMessageEditReplaceDownstream({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    messageId: params.data.messageId,
    content: parsed.data.content,
    actorUserId: scope.userId,
    afterCreatedAt: userMessage.createdAt,
  });

  await recordChatEditAudit(request, scope, params.data.conversationId, correlationId, audit, {
    messageId: String(applied.userMessage._id),
    removedMessageIds: applied.removedMessageIds,
    editGeneration: applied.userMessage.editGeneration ?? 0,
  });

  if (gate.action === 'queue') {
    const queuedAt = new Date();
    const expiresAt = new Date(queuedAt.getTime() + QUEUED_MESSAGE_TTL_MS);
    const jobId = await resolveWriterJobId({ orgId: scope.orgId, projectId: scope.projectId });
    await markUserMessageQueued({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: params.data.conversationId,
      messageId: String(applied.userMessage._id),
      actorUserId: scope.userId,
      blockingJobId: jobId,
      queuedAt,
      expiresAt,
    });
    const body = {
      userMessageId: String(applied.userMessage._id),
      assistantMessageId: null,
      messageStatus: 'queued',
      editGeneration: applied.userMessage.editGeneration ?? 0,
      removedMessageIds: applied.removedMessageIds,
      messageId: String(applied.userMessage._id),
      jobId,
      queuedAt: queuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    await completeChatIdempotency(request, body, 202);
    return reply.code(202).send(body);
  }

  if (!acceptIncludesEventStream(request.headers.accept)) {
    throw ApiError.fromCode('NOT_ACCEPTABLE');
  }

  const assistant = await insertAssistantForExistingUser({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    userMessageId: String(applied.userMessage._id),
    actorUserId: scope.userId,
    knowledgeVersionId: gate.knowledgeVersionId ?? null,
  });

  return streamExistingUserTurnReply(request, reply, {
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    actorUserId: scope.userId,
    userMessageId: String(applied.userMessage._id),
    assistantMessageId: String(assistant._id),
    content: parsed.data.content,
    correlationId,
    gate,
    removedMessageIds: applied.removedMessageIds,
    editGeneration: applied.userMessage.editGeneration ?? 0,
  });
}

/**
 * POST /conversation/chatStream/retryMessage/:projectId/:conversationId/:messageId — retry failed assistant SSE/202.
 * @param {import('fastify').FastifyRequest} request Request with projectScope.
 * @param {import('fastify').FastifyReply} reply SSE, JSON 202, or errors.
 */
export async function retryConversationMessageHttp(request, reply) {
  const params = messageParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }

  const scope = request.projectScope;
  const audit = buildAuditContextFromRequest(request);
  const correlationId = audit.correlationId ?? request.id;

  const conversation = await loadConversationForUser(scope.orgId, scope.projectId, params.data.conversationId, scope.userId);
  assertConversationWritable(conversation, scope.userId);

  const assistantMessage = await findActiveMessageInConversation({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    messageId: params.data.messageId,
  });
  if (!assistantMessage || assistantMessage.role !== 'assistant') {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  if (!MESSAGE_RETRY_ALLOWED_STATUSES.includes(assistantMessage.messageStatus)) {
    throw ApiError.fromCode('MESSAGE_NOT_RETRYABLE');
  }

  const latest = await findLatestActiveMessageInConversation({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
  });
  if (!latest || String(latest._id) !== String(assistantMessage._id)) {
    throw ApiError.fromCode('MESSAGE_NOT_RETRYABLE');
  }

  if (
    await conversationHasInFlightChatMessage({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: params.data.conversationId,
    })
  ) {
    throw ApiError.fromCode('MESSAGE_NOT_RETRYABLE');
  }

  if (!assistantMessage.parentMessageId) {
    throw ApiError.fromCode('MESSAGE_NOT_RETRYABLE');
  }
  const userMessage = await findActiveMessageInConversation({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    messageId: String(assistantMessage.parentMessageId),
  });
  if (!userMessage || userMessage.role !== 'user') {
    throw ApiError.fromCode('MESSAGE_NOT_RETRYABLE');
  }

  const gate = await assertKnowledgeReadable({ orgId: scope.orgId, projectId: scope.projectId });
  if (gate.action === 'deny') {
    throw ApiError.fromCode(gate.code ?? 'KNOWLEDGE_UNAVAILABLE');
  }

  const removedMessageIds = [String(assistantMessage._id)];
  await softDeleteActiveMessageById({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    messageId: String(assistantMessage._id),
    actorUserId: scope.userId,
  });
  await supersedeOpenClarificationSetsForMessages({
    orgId: scope.orgId,
    messageIds: removedMessageIds,
    actorUserId: scope.userId,
  });
  await refreshConversationSearchText({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
  });

  await recordAuditEvent(
    {
      orgId: scope.orgId,
      actorUserId: scope.userId,
      action: 'chat.message_retry',
      resourceType: 'conversation',
      resourceId: params.data.conversationId,
      result: 'success',
      correlationId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      context: {
        messageId: String(assistantMessage._id),
        userMessageId: String(userMessage._id),
        projectId: String(scope.projectId),
      },
    },
    { log: request.log },
  );

  if (gate.action === 'queue') {
    const queuedAt = new Date();
    const expiresAt = new Date(queuedAt.getTime() + QUEUED_MESSAGE_TTL_MS);
    const jobId = await resolveWriterJobId({ orgId: scope.orgId, projectId: scope.projectId });
    await markUserMessageQueued({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId: params.data.conversationId,
      messageId: String(userMessage._id),
      actorUserId: scope.userId,
      blockingJobId: jobId,
      queuedAt,
      expiresAt,
    });
    const body = {
      userMessageId: String(userMessage._id),
      assistantMessageId: null,
      messageStatus: 'queued',
      removedMessageIds,
      messageId: String(userMessage._id),
      jobId,
      queuedAt: queuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    await completeChatIdempotency(request, body, 202);
    return reply.code(202).send(body);
  }

  if (!acceptIncludesEventStream(request.headers.accept)) {
    throw ApiError.fromCode('NOT_ACCEPTABLE');
  }

  const assistant = await insertAssistantForExistingUser({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    userMessageId: String(userMessage._id),
    actorUserId: scope.userId,
    knowledgeVersionId: gate.knowledgeVersionId ?? null,
  });

  return streamExistingUserTurnReply(request, reply, {
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId: params.data.conversationId,
    actorUserId: scope.userId,
    userMessageId: String(userMessage._id),
    assistantMessageId: String(assistant._id),
    content: typeof userMessage.content === 'string' ? userMessage.content : '',
    correlationId,
    gate,
    removedMessageIds,
  });
}

/**
 * Applies in-place content edit, soft-deletes later turns, supersedes open clarify sets, refreshes search.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   content: string,
 *   actorUserId: string,
 *   afterCreatedAt: Date,
 * }} input Edit replace inputs.
 * @returns {Promise<{ userMessage: import('mongoose').Document, removedMessageIds: string[] }>}
 */
async function applyUserMessageEditReplaceDownstream(input) {
  const session = await mongoose.startSession();
  try {
    /** @type {{ userMessage: import('mongoose').Document, removedMessageIds: string[] } | undefined} */
    let outcome;
    await session.withTransaction(async () => {
      const userMessage = await updateUserMessageContentForEdit({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        content: input.content,
        actorUserId: input.actorUserId,
        session,
      });
      if (!userMessage) {
        throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
      }
      const removed = await softDeleteMessagesAfter({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        afterCreatedAt: input.afterCreatedAt,
        afterMessageId: input.messageId,
        actorUserId: input.actorUserId,
        session,
      });
      if (removed.removedAssistantMessageIds.length > 0) {
        await supersedeOpenClarificationSetsForMessages({
          orgId: input.orgId,
          messageIds: removed.removedAssistantMessageIds,
          actorUserId: input.actorUserId,
          session,
        });
      }
      outcome = { userMessage, removedMessageIds: removed.removedMessageIds };
    });
    if (!outcome) {
      throw ApiError.fromCode('INTERNAL_ERROR');
    }
    await refreshConversationSearchText({
      orgId: input.orgId,
      projectId: input.projectId,
      conversationId: input.conversationId,
    });
    return outcome;
  } finally {
    await session.endSession();
  }
}

/**
 * Opens SSE and runs FLOW B for an existing user + new assistant; completes idempotency.
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {import('fastify').FastifyReply} reply Reply.
 * @param {object} streamInput Shared stream fields (no reply).
 * @returns {Promise<void>}
 */
async function streamExistingUserTurnReply(request, reply, streamInput) {
  /** @type {boolean} */
  let clientConnected = true;
  const runAbort = new AbortController();
  const onClose = () => {
    clientConnected = false;
    if (!runAbort.signal.aborted) {
      runAbort.abort();
    }
  };
  request.raw.on('close', onClose);

  /** @type {ReturnType<typeof setInterval> | null} */
  let keepaliveTimer = null;
  /** @type {boolean} */
  let headersOpened = false;

  /**
   * Writes one SSE event when the client is still connected.
   * @param {string} event Event name.
   * @param {unknown} data JSON-serializable payload.
   */
  function writeSse(event, data) {
    if (!clientConnected || !headersOpened) {
      return;
    }
    try {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      clientConnected = false;
      request.log?.warn?.({ ...caughtErrorFields(error) }, 'sse write failed');
    }
  }

  try {
    const outcome = await runChatStreamForExistingUser({
      ...streamInput,
      workspaceRoot: request.server.config.workspace.root,
      log: request.log,
      abortSignal: runAbort.signal,
      isClientConnected: () => clientConnected,
      openSse: () => {
        if (headersOpened) {
          return;
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          [CORRELATION_ID_HEADER]: streamInput.correlationId,
        });
        headersOpened = true;
        keepaliveTimer = setInterval(() => {
          if (!clientConnected || !headersOpened) {
            return;
          }
          try {
            reply.raw.write(': keepalive\n\n');
          } catch {
            clientConnected = false;
          }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        if (typeof keepaliveTimer.unref === 'function') {
          keepaliveTimer.unref();
        }
      },
      writeSse,
    });

    await completeChatIdempotency(request, {
      userMessageId: outcome.userMessageId,
      assistantMessageId: outcome.assistantMessageId,
      messageStatus: outcome.messageStatus,
      removedMessageIds: outcome.removedMessageIds,
      ...(typeof outcome.editGeneration === 'number' ? { editGeneration: outcome.editGeneration } : {}),
    });

    if (headersOpened) {
      reply.raw.end();
    }
  } catch (error) {
    request.log?.error?.({ ...caughtErrorFields(error), headersOpened }, 'chat edit/retry stream request failed');
    if (headersOpened) {
      const frame = buildStreamErrorEvent(error, streamInput.correlationId);
      writeSse(frame.event, frame.data);
      try {
        await completeChatIdempotency(request, {
          userMessageId: streamInput.userMessageId,
          assistantMessageId: streamInput.assistantMessageId,
          messageStatus: 'failed',
          removedMessageIds: streamInput.removedMessageIds ?? [],
        });
      } catch (idempotencyError) {
        request.log?.error?.({ ...caughtErrorFields(idempotencyError) }, 'chat edit/retry idempotency complete failed after SSE error');
      }
      reply.raw.end();
      return;
    }
    if (!canSendJsonError(reply)) {
      request.log?.error?.({ ...caughtErrorFields(error) }, 'chat edit/retry stream failed after headers');
      return;
    }
    throw error;
  } finally {
    request.raw.off('close', onClose);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
    }
  }
}

/**
 * Best-effort audit for a successful message edit persist.
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {{ orgId: string, projectId: string, userId: string }} scope Project scope.
 * @param {string} conversationId Conversation id.
 * @param {string} correlationId Correlation id.
 * @param {{ ip?: string, userAgent?: string }} audit Audit context.
 * @param {{ messageId: string, removedMessageIds: string[], editGeneration: number }} context Ids only.
 * @returns {Promise<void>}
 */
async function recordChatEditAudit(request, scope, conversationId, correlationId, audit, context) {
  await recordAuditEvent(
    {
      orgId: scope.orgId,
      actorUserId: scope.userId,
      action: 'chat.message_edited',
      resourceType: 'conversation',
      resourceId: conversationId,
      result: 'success',
      correlationId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      context: {
        messageId: context.messageId,
        removedCount: context.removedMessageIds.length,
        editGeneration: context.editGeneration,
        projectId: String(scope.projectId),
      },
    },
    { log: request.log },
  );
}

/**
 * True when the error is a cooperative AbortError from graph/tools cancel.
 * @param {unknown} error Caught value.
 * @returns {boolean}
 */
function isChatRunAbortError(error) {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

/**
 * Builds the public outcome object for an existing-user stream.
 * @param {{ editGeneration?: number }} input Stream input.
 * @param {string} userMessageId User message id.
 * @param {string} assistantMessageId Assistant message id.
 * @param {string} messageStatus Terminal status.
 * @param {string[]} removedMessageIds Soft-deleted ids.
 * @returns {object}
 */
function buildExistingUserStreamOutcome(input, userMessageId, assistantMessageId, messageStatus, removedMessageIds) {
  return {
    userMessageId,
    assistantMessageId,
    messageStatus,
    removedMessageIds,
    ...(typeof input.editGeneration === 'number' ? { editGeneration: input.editGeneration } : {}),
  };
}

/**
 * Completes the idempotency claim with a JSON outcome (not the SSE body).
 * @param {import('fastify').FastifyRequest} request Request with idempotency context.
 * @param {object} body Stored body.
 * @param {number} [responseStatus=200] HTTP status stored for replay.
 * @returns {Promise<void>}
 */
async function completeChatIdempotency(request, body, responseStatus = 200) {
  const ctx = request.idempotency;
  if (!ctx?.isOwner || !ctx.recordId || !request.principal?.orgId || !request.principal?.userId) {
    return;
  }
  await completeIdempotencyRecord({
    orgId: request.principal.orgId,
    recordId: ctx.recordId,
    responseStatus,
    responseBody: body,
    resourceId: body.assistantMessageId ?? body.messageId ?? null,
    updatedBy: request.principal.userId,
  });
  ctx.isOwner = false;
}

/**
 * True when Accept includes text/event-stream.
 * @param {string | string[] | undefined} acceptHeader Accept header.
 * @returns {boolean}
 */
export function acceptIncludesEventStream(acceptHeader) {
  const raw = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }
  return raw.split(',').some((part) => part.trim().toLowerCase().startsWith('text/event-stream'));
}

/**
 * Formats one SSE event block (unit-test helper / shared shape).
 * @param {string} event Event name.
 * @param {unknown} data Payload.
 * @returns {string}
 */
export function formatSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      for (const key of issue.keys) {
        details.push({ path: String(key), message: 'Unrecognized key' });
      }
      continue;
    }
    details.push({
      path: issue.path.join('.') || 'body',
      message: issue.message,
    });
  }
  return details;
}
