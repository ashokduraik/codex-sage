/**
 * Clarification sets — persist interrupt questions, validate answers, and resume
 * the paused chat graph over SSE (phase 52).
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { Message } from '../../models/messages.model.js';
import { CLARIFICATION_MAX_ROUNDS } from './chatGraph.helper.js';
import { buildStreamErrorEvent } from '../../platform/streamErrors.js';
import { ClarificationSet } from '../../models/clarificationSet.model.js';
import { completeIdempotencyRecord } from '../../platform/idempotency/index.js';
import { buildAuditContextFromRequest, recordAuditEvent } from '../access/index.js';
import { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import { assertConversationWritable, loadConversationForUser } from './conversation.js';
import { ApiError, caughtErrorFields, canSendJsonError } from '../../platform/errors.js';
import { finalizeAssistantMessage as finalizeAssistantMessageInRepo } from './conversation.helper.js';
import { buildChatGraphThreadId, createMongoChatCheckpointer, resumeChatGraphFromClarification } from './chatGraph.js';

/** Cap free-text clarification answers (named constant, not env). */
export const CLARIFICATION_FREE_TEXT_MAX_LENGTH = 2000;

/** SSE comment keepalive interval while the clarification resume stream is open. */
const CLARIFICATION_SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Echoed on SSE responses (same as HTTP `X-Correlation-Id`). */
const CORRELATION_ID_HEADER = 'X-Correlation-Id';

const answerParamsSchema = z.object({
  projectId: z.string().min(1),
});

const answersBodySchema = z
  .object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    clarificationSetId: z.string().min(1),
    answers: z.record(z.string().min(1), z.union([z.string(), z.array(z.string())])),
  })
  .strict();

/**
 * POST clarification answers and resume the paused assistant run over SSE.
 * @param {import('fastify').FastifyRequest} request Request with projectScope.
 * @param {import('fastify').FastifyReply} reply Hijacked for SSE, or JSON errors / idempotent replay.
 */
export async function answerClarificationHttp(request, reply) {
  const params = answerParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  const parsed = answersBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  if (!acceptIncludesEventStream(request.headers.accept)) {
    throw ApiError.fromCode('NOT_ACCEPTABLE');
  }

  const scope = request.projectScope;
  const audit = buildAuditContextFromRequest(request);
  const correlationId = audit.correlationId ?? request.id;
  const { conversationId, messageId, clarificationSetId, answers } = parsed.data;

  const conversation = await loadConversationForUser(scope.orgId, scope.projectId, conversationId, scope.userId);
  assertConversationWritable(conversation, scope.userId);

  const prepared = await prepareClarificationAnswerResume({
    orgId: scope.orgId,
    projectId: scope.projectId,
    conversationId,
    messageId,
    clarificationSetId,
    answers,
    actorUserId: scope.userId,
  });

  await recordAuditEvent(
    {
      orgId: scope.orgId,
      actorUserId: scope.userId,
      action: 'chat.clarification_answered',
      resourceType: 'conversation',
      resourceId: conversationId,
      result: 'success',
      correlationId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      context: {
        projectId: String(scope.projectId),
        conversationId,
        messageId,
        clarificationSetId,
        roundIndex: prepared.roundIndex,
      },
    },
    { log: request.log },
  );

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
      request.log?.warn?.({ ...caughtErrorFields(error) }, 'clarification sse write failed');
    }
  }

  try {
    const outcome = await runClarificationAnswerStream({
      orgId: scope.orgId,
      projectId: scope.projectId,
      conversationId,
      actorUserId: scope.userId,
      assistantMessageId: messageId,
      clarificationSetId,
      answers: prepared.normalisedAnswers,
      correlationId,
      workspaceRoot: request.server.config.workspace.root,
      log: request.log,
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
        }, CLARIFICATION_SSE_KEEPALIVE_INTERVAL_MS);
        if (typeof keepaliveTimer.unref === 'function') {
          keepaliveTimer.unref();
        }
      },
      writeSse,
    });

    await completeClarificationIdempotency(request, {
      messageId: outcome.assistantMessageId,
      clarificationSetId,
      messageStatus: outcome.messageStatus,
    });

    if (headersOpened) {
      reply.raw.end();
    }
  } catch (error) {
    request.log?.error?.({ ...caughtErrorFields(error), headersOpened }, 'clarification answer stream failed');
    if (headersOpened) {
      const frame = buildStreamErrorEvent(error, correlationId);
      writeSse(frame.event, frame.data);
      try {
        await completeClarificationIdempotency(request, {
          messageId,
          clarificationSetId,
          messageStatus: 'failed',
        });
      } catch (idempotencyError) {
        request.log?.error?.({ ...caughtErrorFields(idempotencyError) }, 'clarification idempotency complete failed after SSE error');
      }
      reply.raw.end();
      return;
    }
    if (!canSendJsonError(reply)) {
      request.log?.error?.({ ...caughtErrorFields(error) }, 'clarification answer failed after headers');
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
 * Persists an open clarification set from a graph interrupt (supersedes prior open sets).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   actorUserId: string | null,
 *   clarificationSet: {
 *     clarificationSetId: string,
 *     questions?: object[],
 *     issuedAt?: string | Date,
 *     roundIndex?: number,
 *   },
 * }} input Interrupt persist inputs.
 * @returns {Promise<object>} Created ClarificationSet document.
 * @throws {import('../../platform/errors.js').ApiError} When round exceeds max.
 */
export async function persistOpenClarificationSetFromInterrupt(input) {
  const clarificationSet = input.clarificationSet;
  if (!clarificationSet?.clarificationSetId) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'clarificationSetId', message: 'clarificationSetId is required' }],
    });
  }

  const roundIndex = Number.isInteger(clarificationSet.roundIndex) ? clarificationSet.roundIndex : 0;
  if (roundIndex >= CLARIFICATION_MAX_ROUNDS) {
    throw ApiError.fromCode('CLARIFICATION_ROUND_EXCEEDED');
  }

  const questions = normaliseStoredQuestions(clarificationSet.questions ?? []);
  const issuedAt =
    clarificationSet.issuedAt instanceof Date
      ? clarificationSet.issuedAt
      : new Date(typeof clarificationSet.issuedAt === 'string' ? clarificationSet.issuedAt : Date.now());

  await supersedeOpenClarificationSetsForMessage({
    orgId: input.orgId,
    messageId: input.messageId,
    actorUserId: input.actorUserId,
  });

  const actorId = input.actorUserId && mongoose.isValidObjectId(input.actorUserId) ? new mongoose.Types.ObjectId(String(input.actorUserId)) : null;

  return ClarificationSet.create({
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
    messageId: new mongoose.Types.ObjectId(String(input.messageId)),
    clarificationSetId: String(clarificationSet.clarificationSetId),
    roundIndex,
    setStatus: 'open',
    questions,
    answers: null,
    issuedAt,
    createdBy: actorId,
    updatedBy: actorId,
  });
}

/**
 * Loads open clarification DTO embeds keyed by assistant message id.
 * @param {string} orgId Tenant id.
 * @param {string[]} messageIds Assistant message ids.
 * @returns {Promise<Map<string, { clarificationSetId: string, roundIndex: number, questions: object[] }>>}
 */
export async function loadOpenClarificationsForMessages(orgId, messageIds) {
  /** @type {Map<string, { clarificationSetId: string, roundIndex: number, questions: object[] }>} */
  const byMessageId = new Map();
  const ids = (Array.isArray(messageIds) ? messageIds : []).filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) {
    return byMessageId;
  }

  const rows = await ClarificationSet.find({
    orgId,
    messageId: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) },
    setStatus: 'open',
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();

  for (const row of rows) {
    byMessageId.set(String(row.messageId), {
      clarificationSetId: row.clarificationSetId,
      roundIndex: row.roundIndex,
      questions: Array.isArray(row.questions) ? row.questions : [],
    });
  }
  return byMessageId;
}

/**
 * Validates an answer map against stored questions (public for unit tests).
 * @param {object[]} questions Stored questions.
 * @param {Record<string, string | string[]>} answers Submitted answers.
 * @returns {Record<string, string | string[]>} Normalised answers (trimmed).
 * @throws {import('../../platform/errors.js').ApiError} VALIDATION_ERROR with details.
 */
export function validateClarificationAnswers(questions, answers) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  /** @type {Record<string, string | string[]>} */
  const normalised = {};
  const answerMap = answers && typeof answers === 'object' ? answers : {};
  const questionList = Array.isArray(questions) ? questions : [];

  for (const question of questionList) {
    const questionId = String(question.id);
    const isRequired = question.required !== false;
    const raw = answerMap[questionId];
    if (raw === undefined || raw === null) {
      if (isRequired) {
        details.push({ path: `answers.${questionId}`, message: 'Answer is required' });
      }
      continue;
    }

    if (question.type === 'single_select') {
      if (typeof raw !== 'string') {
        details.push({ path: `answers.${questionId}`, message: 'Expected a string option' });
        continue;
      }
      const value = raw.trim();
      const options = Array.isArray(question.options) ? question.options : [];
      if (!options.includes(value)) {
        details.push({ path: `answers.${questionId}`, message: 'Option is not in the allowed list' });
        continue;
      }
      normalised[questionId] = value;
      continue;
    }

    if (question.type === 'multi_select') {
      if (!Array.isArray(raw)) {
        details.push({ path: `answers.${questionId}`, message: 'Expected an array of options' });
        continue;
      }
      const options = Array.isArray(question.options) ? question.options : [];
      const values = raw.map((item) => String(item).trim()).filter((item) => item !== '');
      if (isRequired && values.length === 0) {
        details.push({ path: `answers.${questionId}`, message: 'Select at least one option' });
        continue;
      }
      if (values.some((value) => !options.includes(value))) {
        details.push({ path: `answers.${questionId}`, message: 'One or more options are not allowed' });
        continue;
      }
      normalised[questionId] = values;
      continue;
    }

    if (question.type === 'free_text') {
      if (typeof raw !== 'string') {
        details.push({ path: `answers.${questionId}`, message: 'Expected free-text string' });
        continue;
      }
      const value = raw.trim();
      if (isRequired && value === '') {
        details.push({ path: `answers.${questionId}`, message: 'Answer is required' });
        continue;
      }
      if (value.length > CLARIFICATION_FREE_TEXT_MAX_LENGTH) {
        details.push({
          path: `answers.${questionId}`,
          message: `Text must be at most ${CLARIFICATION_FREE_TEXT_MAX_LENGTH} characters`,
        });
        continue;
      }
      normalised[questionId] = value;
      continue;
    }

    details.push({ path: `answers.${questionId}`, message: 'Unknown question type' });
  }

  if (details.length > 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details });
  }
  return normalised;
}

/**
 * Loads open set, validates answers, marks answered, and moves message to generating.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   clarificationSetId: string,
 *   answers: Record<string, string | string[]>,
 *   actorUserId: string,
 * }} input Prepare inputs.
 * @returns {Promise<{ normalisedAnswers: Record<string, string | string[]>, roundIndex: number }>}
 */
async function prepareClarificationAnswerResume(input) {
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.conversationId) || !mongoose.isValidObjectId(input.messageId)) {
    throw ApiError.fromCode('NOT_FOUND');
  }

  const setRow = await ClarificationSet.findOne({
    orgId: input.orgId,
    clarificationSetId: input.clarificationSetId,
    status: ROW_STATUS_ACTIVE,
  }).exec();

  if (
    !setRow ||
    String(setRow.projectId) !== String(input.projectId) ||
    String(setRow.conversationId) !== String(input.conversationId) ||
    String(setRow.messageId) !== String(input.messageId)
  ) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  if (setRow.setStatus !== 'open') {
    throw ApiError.fromCode('CLARIFICATION_NOT_OPEN');
  }

  const message = await Message.findOne({
    _id: new mongoose.Types.ObjectId(String(input.messageId)),
    orgId: input.orgId,
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    conversationId: new mongoose.Types.ObjectId(String(input.conversationId)),
    role: 'assistant',
    status: ROW_STATUS_ACTIVE,
  }).exec();

  if (!message) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  if (message.messageStatus !== 'awaiting_clarification') {
    throw ApiError.fromCode('CLARIFICATION_NOT_OPEN');
  }

  const normalisedAnswers = validateClarificationAnswers(setRow.questions, input.answers);

  const actorId = mongoose.isValidObjectId(input.actorUserId) ? new mongoose.Types.ObjectId(String(input.actorUserId)) : null;

  setRow.answers = normalisedAnswers;
  setRow.setStatus = 'answered';
  setRow.updatedBy = actorId;
  await setRow.save();

  await finalizeAssistantMessageInRepo({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    assistantMessageId: input.messageId,
    content: message.content ?? '',
    messageStatus: 'generating',
    updatedBy: input.actorUserId,
  });

  return { normalisedAnswers, roundIndex: setRow.roundIndex };
}

/**
 * Resumes the graph after answers are persisted; streams SSE and finalizes the assistant row.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   assistantMessageId: string,
 *   clarificationSetId: string,
 *   answers: Record<string, string | string[]>,
 *   correlationId: string,
 *   workspaceRoot: string,
 *   log?: import('fastify').FastifyBaseLogger,
 *   isClientConnected: () => boolean,
 *   openSse: () => void,
 *   writeSse: (event: string, data: unknown) => void,
 * }} input Stream inputs.
 * @returns {Promise<{ assistantMessageId: string, messageStatus: string }>}
 */
async function runClarificationAnswerStream(input) {
  input.openSse();
  input.writeSse('status', { stage: 'generating' });

  const threadId = buildChatGraphThreadId(input.orgId, input.conversationId, input.assistantMessageId);
  const checkpointer = createMongoChatCheckpointer();

  /** @type {string} */
  let terminalStatus = 'completed';
  /** @type {boolean} */
  let sawDone = false;

  try {
    const result = await resumeChatGraphFromClarification({
      threadId,
      checkpointer,
      clarificationSetId: input.clarificationSetId,
      answers: input.answers,
      onStage: (event) => {
        // writeSse no-ops after disconnect (same as chatStream keepalive path).
        input.writeSse('status', { stage: event.stage });
      },
      onDelta: (text) => {
        if (typeof text === 'string' && text.length > 0) {
          input.writeSse('delta', { text });
        }
      },
      onEvidence: (items) => {
        input.writeSse('evidence', { items: Array.isArray(items) ? items : [] });
      },
      onDone: (payload) => {
        sawDone = true;
        terminalStatus = 'completed';
        input.writeSse('done', { messageId: String(payload?.messageId ?? input.assistantMessageId) });
      },
      onError: (error) => {
        terminalStatus = 'failed';
        const frame = buildStreamErrorEvent(error, input.correlationId);
        input.writeSse(frame.event, frame.data);
      },
    });

    if (result?.__interrupt__) {
      const clarificationSet = result.__interrupt__[0]?.value;
      terminalStatus = 'awaiting_clarification';
      if (clarificationSet) {
        await persistOpenClarificationSetFromInterrupt({
          orgId: input.orgId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          messageId: input.assistantMessageId,
          actorUserId: input.actorUserId,
          clarificationSet,
        });
      }
      await finalizeAssistantMessageInRepo({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId,
        content: '',
        messageStatus: 'awaiting_clarification',
        updatedBy: input.actorUserId,
      });
      if (clarificationSet) {
        input.writeSse('clarification', {
          clarificationSetId: clarificationSet.clarificationSetId,
          roundIndex: clarificationSet.roundIndex ?? 0,
          questions: clarificationSet.questions ?? [],
        });
      }
      return { assistantMessageId: input.assistantMessageId, messageStatus: terminalStatus };
    }

    if (terminalStatus !== 'failed') {
      try {
        const row = await finalizeAssistantMessageInRepo({
          orgId: input.orgId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          content: typeof result?.answerContent === 'string' ? result.answerContent : '',
          messageStatus: result?.supportLevel === 'insufficient' || result?.route === 'abstain_early' ? 'abstained' : 'completed',
          updatedBy: input.actorUserId,
        });
        terminalStatus = row.messageStatus;
        if (!sawDone) {
          input.writeSse('done', { messageId: input.assistantMessageId });
        }
      } catch (persistError) {
        input.log?.error?.({ ...caughtErrorFields(persistError) }, 'clarification resume failed to finalize assistant message');
      }
    }

    return { assistantMessageId: input.assistantMessageId, messageStatus: terminalStatus };
  } catch (error) {
    terminalStatus = 'failed';
    try {
      await finalizeAssistantMessageInRepo({
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId,
        content: '',
        messageStatus: 'failed',
        updatedBy: input.actorUserId,
      });
    } catch (persistError) {
      input.log?.error?.({ ...caughtErrorFields(persistError) }, 'clarification resume failed to mark assistant failed');
    }
    throw error;
  }
}

/**
 * Soft-deletes open clarification sets for a message before a new open set is written.
 * @param {{ orgId: string, messageId: string, actorUserId: string | null }} input Scope.
 * @returns {Promise<void>}
 */
async function supersedeOpenClarificationSetsForMessage(input) {
  await supersedeOpenClarificationSetsForMessages({
    orgId: input.orgId,
    messageIds: [input.messageId],
    actorUserId: input.actorUserId,
  });
}

/**
 * Marks open clarification sets for the given assistant message ids as superseded (edit replace-downstream).
 * @param {{
 *   orgId: string,
 *   messageIds: string[],
 *   actorUserId?: string | null,
 *   session?: import('mongoose').ClientSession,
 * }} input Scope.
 * @returns {Promise<void>}
 */
export async function supersedeOpenClarificationSetsForMessages(input) {
  const ids = (Array.isArray(input.messageIds) ? input.messageIds : []).filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) {
    return;
  }
  const actorId = input.actorUserId && mongoose.isValidObjectId(input.actorUserId) ? new mongoose.Types.ObjectId(String(input.actorUserId)) : null;
  let query = ClarificationSet.updateMany(
    {
      orgId: input.orgId,
      messageId: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) },
      setStatus: 'open',
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        setStatus: 'superseded',
        status: ROW_STATUS_DELETED,
        updatedBy: actorId,
      },
    },
  );
  if (input.session) {
    query = query.session(input.session);
  }
  await query.exec();
}

/**
 * Normalises interrupt questions for storage (default required true).
 * @param {object[]} questions Raw questions.
 * @returns {object[]}
 */
function normaliseStoredQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((question, index) => {
    /** @type {{ id: string, type: string, prompt: string, required: boolean, options?: string[] }} */
    const entry = {
      id: typeof question?.id === 'string' && question.id !== '' ? question.id : `q${index + 1}`,
      type: question.type,
      prompt: typeof question.prompt === 'string' ? question.prompt : '',
      required: question.required !== false,
    };
    if (Array.isArray(question.options)) {
      entry.options = question.options.map((option) => String(option));
    }
    return entry;
  });
}

/**
 * Completes the idempotency claim with a JSON outcome (not the SSE body).
 * @param {import('fastify').FastifyRequest} request Request with idempotency context.
 * @param {object} body Stored body.
 * @param {number} [responseStatus=200] HTTP status stored for replay.
 * @returns {Promise<void>}
 */
async function completeClarificationIdempotency(request, body, responseStatus = 200) {
  const ctx = request.idempotency;
  if (!ctx?.isOwner || !ctx.recordId || !request.principal?.orgId || !request.principal?.userId) {
    return;
  }
  await completeIdempotencyRecord({
    orgId: request.principal.orgId,
    recordId: ctx.recordId,
    responseStatus,
    responseBody: body,
    resourceId: body.messageId ?? null,
    updatedBy: request.principal.userId,
  });
  ctx.isOwner = false;
}

/**
 * True when Accept includes text/event-stream.
 * @param {string | string[] | undefined} acceptHeader Accept header.
 * @returns {boolean}
 */
function acceptIncludesEventStream(acceptHeader) {
  const raw = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }
  return raw.split(',').some((part) => part.trim().toLowerCase().startsWith('text/event-stream'));
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
