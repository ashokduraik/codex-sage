/**
 * conversation/conversation.js — merged resource file.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { buildAuditContextFromRequest, recordAuditEvent } from '../access/index.js';
import { adjustProjectConversationCount } from '../masters/index.js';
import mongoose from 'mongoose';
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  CONVERSATION_SEARCH_SNIPPET_MAX_CHARS,
  CONVERSATION_TRUNCATED_TITLE_MAX_CHARS,
  archiveOwnConversation,
  findConversationInProject,
  findOwnConversation,
  insertConversation,
  listMessagesForConversation,
  listOwnConversations,
  listRecentMessages as listRecentMessagesInRepo,
  refreshConversationSearchText,
  restoreOwnConversation,
  searchOwnConversations,
  softDeleteOwnConversation,
  updateConversationTitleFields,
} from './conversation.helper.js';
import { z } from 'zod';

// --- from conversations/conversations.routes.js ---
/**
 * Conversation HTTP routes under `/api/v1/projects/:projectId/conversations`.
 */
const createBodySchema = z.object({
  title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_LENGTH).optional(),
});

const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_LENGTH),
  })
  .strict();

const archivedQueryTransform = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((value) => value === true || value === 'true' || value === '1');

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
  archived: archivedQueryTransform,
});

const searchQuerySchema = z.object({
  q: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
  archived: archivedQueryTransform,
});

const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

const conversationParamsSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
});

/**
 * Registers conversation routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function conversationRoutes(app) {
  const askPreHandler = requireProjectPermission('chat.ask');
  const archivePreHandler = requireProjectPermission('conversations.archive');
  const searchPreHandler = requireProjectPermission('conversations.search');

  app.post(
    '/projects/:projectId/conversations',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
      preHandler: askPreHandler,
    },
    async (request, reply) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const conversation = await createConversation({
        ...serviceContext(request),
        title: parsed.data.title,
      });
      return reply.code(201).send(conversation);
    },
  );

  app.get(
    '/projects/:projectId/conversations',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: askPreHandler,
    },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      assertPositiveLimit(parsed.data.limit);
      const ctx = serviceContext(request);
      return listConversations(ctx.orgId, ctx.projectId, ctx.actorUserId, parsed.data);
    },
  );

  app.get(
    '/projects/:projectId/conversations/search',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: searchPreHandler,
    },
    async (request) => {
      const parsed = searchQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      assertPositiveLimit(parsed.data.limit);
      const ctx = serviceContext(request);
      return searchConversations({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        userId: ctx.actorUserId,
        q: parsed.data.q,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
        archived: parsed.data.archived,
      });
    },
  );

  app.get(
    '/projects/:projectId/conversations/:conversationId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: askPreHandler,
    },
    async (request) => {
      const params = parseConversationParams(request.params);
      const ctx = serviceContext(request);
      return getConversation(ctx.orgId, ctx.projectId, params.conversationId, ctx.actorUserId);
    },
  );

  app.get(
    '/projects/:projectId/conversations/:conversationId/messages',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: askPreHandler,
    },
    async (request) => {
      const params = parseConversationParams(request.params);
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      assertPositiveLimit(parsed.data.limit);
      const ctx = serviceContext(request);
      return listConversationMessages(ctx.orgId, ctx.projectId, params.conversationId, ctx.actorUserId, parsed.data);
    },
  );

  app.patch(
    '/projects/:projectId/conversations/:conversationId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: askPreHandler,
    },
    async (request) => {
      const params = parseConversationParams(request.params);
      const parsed = patchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      return updateConversationTitle({
        ...serviceContext(request),
        conversationId: params.conversationId,
        title: parsed.data.title,
      });
    },
  );

  app.post(
    '/projects/:projectId/conversations/:conversationId/archive',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: archivePreHandler,
    },
    async (request) => {
      const params = parseConversationParams(request.params);
      return archiveConversation({
        ...serviceContext(request),
        conversationId: params.conversationId,
      });
    },
  );

  app.post(
    '/projects/:projectId/conversations/:conversationId/restore',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: archivePreHandler,
    },
    async (request) => {
      const params = parseConversationParams(request.params);
      return restoreConversation({
        ...serviceContext(request),
        conversationId: params.conversationId,
      });
    },
  );

  app.delete(
    '/projects/:projectId/conversations/:conversationId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: archivePreHandler,
    },
    async (request, reply) => {
      const params = parseConversationParams(request.params);
      await deleteConversation({
        ...serviceContext(request),
        conversationId: params.conversationId,
      });
      return reply.code(204).send();
    },
  );
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

/**
 * Shared request context for conversation services.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log: import('fastify').FastifyBaseLogger,
 * }}
 */
function serviceContext(request) {
  const audit = buildAuditContextFromRequest(request);
  const scope = request.projectScope;
  return {
    orgId: scope.orgId,
    projectId: scope.projectId,
    actorUserId: scope.userId,
    correlationId: audit.correlationId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    log: request.log,
  };
}

/**
 * Parses conversation params or throws VALIDATION_ERROR.
 * @param {unknown} params Route params.
 * @returns {{ projectId: string, conversationId: string }}
 */
function parseConversationParams(params) {
  const parsed = conversationParamsSchema.safeParse(params ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  return parsed.data;
}

/**
 * Rejects limit=0 after zod coerce (same as jobs/projects).
 * @param {number | undefined} limit Parsed limit.
 */
function assertPositiveLimit(limit) {
  if (limit === 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'limit', message: 'limit must be a positive integer' }],
    });
  }
}

// --- from conversations/conversations.service.js ---
/**
 * Conversation use cases — audit, counts, owner-only visibility.
 */
/**
 * Maps a conversation row to the create/get/patch header.
 * @param {object} conversation Conversation document or lean object.
 * @returns {object}
 */
export function mapConversationToDto(conversation) {
  return {
    id: String(conversation._id ?? conversation.id),
    projectId: String(conversation.projectId),
    title: conversation.title,
    titleSource: conversation.titleSource,
    lifecycleStatus: conversation.lifecycleStatus,
    ownerUserId: String(conversation.ownerUserId),
    messageCount: conversation.messageCount ?? 0,
    lastMessageAt: toIsoOrNull(conversation.lastMessageAt),
    archivedAt: toIsoOrNull(conversation.archivedAt),
    createdAt: toIsoOrEmpty(conversation.createdAt),
    updatedAt: toIsoOrEmpty(conversation.updatedAt),
  };
}

/**
 * Maps a conversation row to the list item (no ownerUserId).
 * @param {object} conversation Conversation document or lean object.
 * @returns {object}
 */
export function mapConversationToListDto(conversation) {
  return {
    id: String(conversation._id ?? conversation.id),
    title: conversation.title,
    lifecycleStatus: conversation.lifecycleStatus,
    messageCount: conversation.messageCount ?? 0,
    lastMessageAt: toIsoOrNull(conversation.lastMessageAt),
    updatedAt: toIsoOrEmpty(conversation.updatedAt),
  };
}

/**
 * Maps a message row to the thread list item. Null reserved fields are omitted.
 * @param {object} message Message document or lean object.
 * @returns {object}
 */
export function mapMessageToDto(message) {
  /** @type {Record<string, unknown>} */
  const dto = {
    id: String(message._id ?? message.id),
    role: message.role,
    content: message.content,
    messageStatus: message.messageStatus,
    createdAt: toIsoOrEmpty(message.createdAt),
  };
  if (message.evidence != null) {
    dto.evidence = message.evidence;
  }
  if (message.usage != null) {
    dto.usage = message.usage;
  }
  if (message.contextMetrics != null) {
    dto.contextMetrics = message.contextMetrics;
  }
  return dto;
}

/**
 * Maps a conversation row to a search hit with a snippet.
 * @param {object} conversation Conversation document or lean object.
 * @param {string} snippet Plain-text snippet.
 * @returns {object}
 */
export function mapConversationToSearchDto(conversation, snippet) {
  return {
    id: String(conversation._id ?? conversation.id),
    title: conversation.title,
    snippet,
    updatedAt: toIsoOrEmpty(conversation.updatedAt),
    titleSource: conversation.titleSource,
  };
}

/**
 * Throws when an archived conversation cannot accept writes (Phase 50).
 * Cross-owner and missing rows are 404, not 403.
 * @param {object | null | undefined} conversation Loaded conversation row.
 * @param {import('mongoose').Types.ObjectId | string} userId Caller user id.
 * @throws {import('../../platform/errors.js').ApiError}
 */
export function assertConversationWritable(conversation, userId) {
  if (!conversation) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  if (String(conversation.ownerUserId) !== String(userId)) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  if (conversation.lifecycleStatus !== 'active') {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'write' },
    });
  }
}

/**
 * Throws unless the conversation can move to archived.
 * @param {object} conversation Loaded conversation row.
 * @throws {import('../../platform/errors.js').ApiError} INVALID_STATE_TRANSITION
 */
export function assertConversationArchiveAllowed(conversation) {
  if (conversation.lifecycleStatus !== 'active') {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'archived' },
    });
  }
}

/**
 * Throws unless the conversation can move back to active.
 * @param {object} conversation Loaded conversation row.
 * @throws {import('../../platform/errors.js').ApiError} INVALID_STATE_TRANSITION
 */
export function assertConversationRestoreAllowed(conversation) {
  if (conversation.lifecycleStatus !== 'archived') {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'active' },
    });
  }
}

/**
 * Normalizes and validates a search query string.
 * @param {unknown} raw Raw `q` value.
 * @returns {string}
 * @throws {import('../../platform/errors.js').ApiError} VALIDATION_ERROR
 */
export function parseConversationSearchQuery(raw) {
  if (typeof raw !== 'string') {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'q', message: 'q is required' }],
    });
  }
  const query = raw.trim();
  if (query.length < CONVERSATION_SEARCH_MIN_QUERY_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'q',
          message: `q must be at least ${CONVERSATION_SEARCH_MIN_QUERY_LENGTH} characters`,
        },
      ],
    });
  }
  return query;
}

/**
 * Builds a plain-text snippet from title or searchText, capped and ellipsized.
 * @param {{ title?: string, searchText?: string }} conversation Conversation fields.
 * @param {string} query Search query.
 * @param {number} [maxChars] Snippet cap.
 * @returns {string}
 */
export function buildConversationSnippet(conversation, query, maxChars) {
  const cap = maxChars ?? CONVERSATION_SEARCH_SNIPPET_MAX_CHARS;
  const title = typeof conversation.title === 'string' ? conversation.title : '';
  const searchText = typeof conversation.searchText === 'string' ? conversation.searchText : '';
  const needle = query.toLowerCase();
  const source = title.toLowerCase().includes(needle) ? title : searchText || title;
  if (source.length <= cap) {
    return source;
  }
  if (cap <= 3) {
    return source.slice(0, cap);
  }
  return `${source.slice(0, cap - 3)}...`;
}

/**
 * Truncates user text into a title-safe string.
 * @param {string} text Source text.
 * @param {number} maxChars Cap.
 * @returns {string}
 */
export function truncateUserTextTitle(text, maxChars) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return collapsed.slice(0, maxChars).trimEnd();
}

/**
 * Sets a truncated first-user-message title when the row still has the default title.
 * Does not call a model. Missing rows and non-default titles are no-ops so `done` is never blocked.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   firstUserContent?: string,
 *   assistantMessageId?: string,
 * }} input Auto-title inputs.
 * @returns {Promise<void>}
 */
export async function scheduleConversationAutoTitle(input) {
  const raw = typeof input.firstUserContent === 'string' ? input.firstUserContent.slice(0, CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS) : '';
  const title = truncateUserTextTitle(raw, CONVERSATION_TRUNCATED_TITLE_MAX_CHARS);
  if (!title) {
    return;
  }

  const conversation = await findConversationInProject(input.orgId, input.projectId, input.conversationId);
  if (!conversation || conversation.titleSource !== 'default') {
    return;
  }

  await updateConversationTitleFields({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    title,
    titleSource: 'truncated_user_text',
  });
  await refreshConversationSearchText({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
  });
}

/**
 * Loads a conversation the caller owns or throws CONVERSATION_NOT_FOUND.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} userId Caller user id.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function loadConversationForUser(orgId, projectId, conversationId, userId) {
  const conversation = await findOwnConversation(orgId, projectId, conversationId, userId);
  if (!conversation) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  return conversation;
}

/**
 * Creates a conversation and increments the project count.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   title?: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Create inputs.
 * @returns {Promise<object>}
 */
export async function createConversation(input) {
  const mongoSession = await mongoose.startSession();
  /** @type {import('mongoose').Document | undefined} */
  let created;
  try {
    await mongoSession.withTransaction(async () => {
      created = await insertConversation(
        {
          orgId: input.orgId,
          projectId: input.projectId,
          ownerUserId: input.actorUserId,
          title: input.title,
          titleSource: input.title ? 'user' : 'default',
        },
        { session: mongoSession },
      );
      await adjustProjectConversationCount(input.orgId, input.projectId, 1, {
        session: mongoSession,
      });
    });
  } finally {
    await mongoSession.endSession();
  }
  if (!created) {
    throw ApiError.fromCode('INTERNAL_ERROR');
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.created',
      resourceType: 'conversation',
      resourceId: String(created._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        projectId: input.projectId,
        conversationId: String(created._id),
        titleLength: created.title.length,
      },
    },
    { log: input.log },
  );
  return mapConversationToDto(created);
}

/**
 * Lists the caller's conversations.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} userId Caller user id.
 * @param {{ cursor?: string, limit?: unknown, archived?: boolean }} [filters] List filters.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function listConversations(orgId, projectId, userId, filters = {}) {
  const page = await listOwnConversations(orgId, projectId, userId, filters);
  return {
    items: page.items.map(mapConversationToListDto),
    nextCursor: page.nextCursor,
  };
}

/**
 * Returns one conversation header the caller owns.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} userId Caller user id.
 * @returns {Promise<object>}
 */
export async function getConversation(orgId, projectId, conversationId, userId) {
  const conversation = await loadConversationForUser(orgId, projectId, conversationId, userId);
  return mapConversationToDto(conversation);
}

/**
 * Lists messages after confirming the caller owns the conversation.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} userId Caller user id.
 * @param {{ cursor?: string, limit?: unknown }} [filters] Page filters.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function listConversationMessages(orgId, projectId, conversationId, userId, filters = {}) {
  await loadConversationForUser(orgId, projectId, conversationId, userId);
  const page = await listMessagesForConversation(orgId, projectId, conversationId, filters);
  return {
    items: page.items.map(mapMessageToDto),
    nextCursor: page.nextCursor,
  };
}

/**
 * Recent messages for later context phases (conversation must already be authorized).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {number} [limit] Max rows.
 * @returns {Promise<object[]>}
 */
export async function listRecentMessages(orgId, projectId, conversationId, limit) {
  const rows = await listRecentMessagesInRepo(orgId, projectId, conversationId, limit);
  return rows.map(mapMessageToDto);
}

/**
 * Archives an owned conversation.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Archive inputs.
 * @returns {Promise<object>}
 */
export async function archiveConversation(input) {
  const conversation = await loadConversationForUser(input.orgId, input.projectId, input.conversationId, input.actorUserId);
  assertConversationArchiveAllowed(conversation);
  const updated = await archiveOwnConversation({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    userId: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'archived' },
    });
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.archived',
      resourceType: 'conversation',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { projectId: input.projectId, conversationId: String(updated._id) },
    },
    { log: input.log },
  );
  return mapConversationToDto(updated);
}

/**
 * Restores an owned archived conversation.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Restore inputs.
 * @returns {Promise<object>}
 */
export async function restoreConversation(input) {
  const conversation = await loadConversationForUser(input.orgId, input.projectId, input.conversationId, input.actorUserId);
  assertConversationRestoreAllowed(conversation);
  const updated = await restoreOwnConversation({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    userId: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: conversation.lifecycleStatus, to: 'active' },
    });
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.restored',
      resourceType: 'conversation',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { projectId: input.projectId, conversationId: String(updated._id) },
    },
    { log: input.log },
  );
  return mapConversationToDto(updated);
}

/**
 * Soft-deletes an owned conversation and decrements the project count.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Delete inputs.
 * @returns {Promise<void>}
 */
export async function deleteConversation(input) {
  await loadConversationForUser(input.orgId, input.projectId, input.conversationId, input.actorUserId);
  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      const result = await softDeleteOwnConversation(
        {
          orgId: input.orgId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          userId: input.actorUserId,
        },
        { session: mongoSession },
      );
      if (!result.modifiedCount) {
        throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
      }
      await adjustProjectConversationCount(input.orgId, input.projectId, -1, {
        session: mongoSession,
      });
    });
  } finally {
    await mongoSession.endSession();
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.deleted',
      resourceType: 'conversation',
      resourceId: input.conversationId,
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { projectId: input.projectId, conversationId: input.conversationId },
    },
    { log: input.log },
  );
}

/**
 * Renames an owned conversation and records title lengths only.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   title: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Patch inputs.
 * @returns {Promise<object>}
 */
export async function updateConversationTitle(input) {
  const conversation = await loadConversationForUser(input.orgId, input.projectId, input.conversationId, input.actorUserId);
  const title = input.title.trim();
  if (!title || title.length > CONVERSATION_TITLE_MAX_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'title',
          message: `title must be 1–${CONVERSATION_TITLE_MAX_LENGTH} characters`,
        },
      ],
    });
  }
  const updated = await updateConversationTitleFields({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    userId: input.actorUserId,
    title,
    titleSource: 'user',
  });
  if (!updated) {
    throw ApiError.fromCode('CONVERSATION_NOT_FOUND');
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'conversation.title_changed',
      resourceType: 'conversation',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        projectId: input.projectId,
        conversationId: String(updated._id),
        oldTitleLength: conversation.title.length,
        newTitleLength: title.length,
      },
    },
    { log: input.log },
  );
  return mapConversationToDto(updated);
}

/**
 * Searches the caller's conversations by title and message searchText.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   userId: string,
 *   q: unknown,
 *   cursor?: string,
 *   limit?: unknown,
 *   archived?: boolean,
 * }} input Search inputs.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function searchConversations(input) {
  const q = parseConversationSearchQuery(input.q);
  const page = await searchOwnConversations({
    orgId: input.orgId,
    projectId: input.projectId,
    userId: input.userId,
    q,
    cursor: input.cursor,
    limit: input.limit,
    archived: input.archived,
  });
  return {
    items: page.items.map((row) => mapConversationToSearchDto(row, buildConversationSnippet(row, q))),
    nextCursor: page.nextCursor,
  };
}

/**
 * Formats a date as ISO-8601, or empty string when missing.
 * @param {unknown} value Date or string.
 * @returns {string}
 */
function toIsoOrEmpty(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value ?? '');
}

/**
 * Formats a date as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

export {
  CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS,
  CONVERSATION_DEFAULT_TITLE,
  CONVERSATION_LIFECYCLE_STATUS_VALUES,
  CONVERSATION_SEARCH_DEFAULT_LIMIT,
  CONVERSATION_SEARCH_MAX_LIMIT,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  CONVERSATION_SEARCH_SNIPPET_MAX_CHARS,
  CONVERSATION_SEARCH_TEXT_MAX_CHARS,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TITLE_SOURCE_VALUES,
  CONVERSATION_TRUNCATED_TITLE_MAX_CHARS,
  CONVERSATIONS_LIST_DEFAULT_LIMIT,
  CONVERSATIONS_LIST_MAX_LIMIT,
  MESSAGE_ROLE_VALUES,
  MESSAGE_STATUS_VALUES,
  MESSAGES_LIST_DEFAULT_LIMIT,
  MESSAGES_LIST_MAX_LIMIT,
  buildOwnConversationFilter,
  refreshConversationSearchText,
} from './conversation.helper.js';

import { Conversation } from '../../models/conversations.model.js';
import { Message } from '../../models/messages.model.js';
export { Conversation, Message };
export const CONVERSATION_MODELS = Object.freeze([Conversation, Message]);
