/**
 * Conversation HTTP routes under `/api/v1/projects/:projectId/conversations`.
 */
import { z } from 'zod';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { buildAuditContextFromRequest } from '../audit/index.js';
import { CONVERSATION_TITLE_MAX_LENGTH } from './conversations.constants.js';
import {
  archiveConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversationMessages,
  listConversations,
  restoreConversation,
  searchConversations,
  updateConversationTitle,
} from './conversations.service.js';

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
      return listConversationMessages(
        ctx.orgId,
        ctx.projectId,
        params.conversationId,
        ctx.actorUserId,
        parsed.data,
      );
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
