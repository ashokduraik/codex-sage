/**
 * Chat message SSE transport — POST ask with Accept: text/event-stream,
 * knowledge gate, queued 202 when updating, idempotent completion, and LangGraph hooks.
 */
import { z } from 'zod';
import { findProjectById } from '../masters/index.js';
import { assertKnowledgeReadable } from '../knowledge/index.js';
import { buildStreamErrorEvent } from '../../platform/streamErrors.js';
import { enqueueChatMessageWhileKnowledgeUpdating } from './chatQueue.js';
import { completeIdempotencyRecord } from '../../platform/idempotency/index.js';
import { buildAuditContextFromRequest, recordAuditEvent } from '../access/index.js';
import { assertConversationWritable, loadConversationForUser } from './conversation.js';
import { ApiError, caughtErrorFields, canSendJsonError } from '../../platform/errors.js';
import { invokeChatGraph, buildChatGraphThreadId, createMongoChatCheckpointer } from './chatGraph.js';
import { insertChatTurnPair, finalizeAssistantMessage as finalizeAssistantMessageInRepo } from './conversation.helper.js';

/** Echoed on SSE responses (same as HTTP `X-Correlation-Id`). */
const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Max user question length for POST messages (named constant, not env). */
export const CHAT_MESSAGE_CONTENT_MAX_LENGTH = 16_000;

/** SSE comment keepalive interval while the stream is open. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

const conversationParamsSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
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
  const onClose = () => {
    clientConnected = false;
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

  const project = await findProjectById(input.orgId, input.projectId);
  const knowledgeHealth = typeof project?.knowledgeHealth === 'string' ? project.knowledgeHealth : undefined;

  const pair = await insertChatTurnPair({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
    content: input.content,
    knowledgeVersionId: gate.knowledgeVersionId ?? null,
  });
  const userMessageId = String(pair.userMessage._id);
  const assistantMessageId = String(pair.assistantMessage._id);

  input.openSse();
  input.writeSse('status', {
    stage: 'accepted',
    ...(knowledgeHealth ? { knowledgeHealth } : {}),
  });

  const threadId = buildChatGraphThreadId(input.orgId, input.conversationId, assistantMessageId);
  const checkpointer = createMongoChatCheckpointer();

  /** @type {string} */
  let terminalStatus = 'completed';
  /** @type {boolean} */
  let sawDone = false;

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
        sawDone = true;
        terminalStatus = 'completed';
        if (!input.isClientConnected()) {
          return;
        }
        input.writeSse('done', { messageId: String(payload?.messageId ?? assistantMessageId) });
      },
      onError: (error) => {
        terminalStatus = 'failed';
        if (!input.isClientConnected()) {
          return;
        }
        const frame = buildStreamErrorEvent(error, input.correlationId);
        input.writeSse(frame.event, frame.data);
      },
    });

    if (result?.__interrupt__) {
      const clarificationSet = result.__interrupt__[0]?.value;
      terminalStatus = 'awaiting_clarification';
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
          clarificationSetId: clarificationSet.clarificationSetId,
          questions: clarificationSet.questions ?? [],
        });
      }
      return { userMessageId, assistantMessageId, messageStatus: terminalStatus };
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

    return { userMessageId, assistantMessageId, messageStatus: terminalStatus };
  } catch (error) {
    terminalStatus = 'failed';
    try {
      await finalizeAssistantMessageInRepo({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        assistantMessageId,
        content: '',
        messageStatus: 'failed',
        updatedBy: input.actorUserId,
      });
    } catch (persistError) {
      input.log?.error?.({ ...caughtErrorFields(persistError) }, 'chat stream failed to mark assistant failed');
    }
    throw error;
  }
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
