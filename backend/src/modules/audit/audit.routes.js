/**
 * Audit event HTTP routes — list and detail (append-only; no writes).
 */
import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { isKnownAuditAction } from './audit.actions.js';
import { getAuditEventForOrg, listAuditEventsForOrg } from './audit.service.js';

const listQuerySchema = z
  .object({
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    resourceType: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

const idParamsSchema = z.object({
  auditEventId: z.string().min(1),
});

/**
 * Parses an optional ISO-8601 UTC instant.
 * @param {string | undefined} value Raw query value.
 * @param {string} path Field path for errors.
 * @returns {Date | undefined}
 */
function parseOptionalInstant(value, path) {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path, message: `${path} must be a valid ISO-8601 instant` }],
    });
  }
  return date;
}

/**
 * Registers `GET /audit-events` and `GET /audit-events/:auditEventId`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function auditRoutes(app) {
  app.get(
    '/audit-events',
    {
      config: {
        requiredPermissions: ['audit.view'],
      },
    },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'query',
            message: issue.message,
          })),
        });
      }

      if (parsed.data.action && !isKnownAuditAction(parsed.data.action)) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'action', message: 'unknown audit action' }],
        });
      }
      if (parsed.data.actor && !mongoose.isValidObjectId(parsed.data.actor)) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'actor', message: 'actor must be a valid ObjectId' }],
        });
      }

      const principal = request.principal;
      return listAuditEventsForOrg(principal.orgId, {
        from: parseOptionalInstant(parsed.data.from, 'from'),
        to: parseOptionalInstant(parsed.data.to, 'to'),
        actor: parsed.data.actor,
        action: parsed.data.action,
        resourceType: parsed.data.resourceType,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });
    },
  );

  app.get(
    '/audit-events/:auditEventId',
    {
      config: {
        requiredPermissions: ['audit.view'],
      },
    },
    async (request) => {
      const params = idParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: params.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'auditEventId',
            message: issue.message,
          })),
        });
      }
      const principal = request.principal;
      return getAuditEventForOrg(principal.orgId, params.data.auditEventId);
    },
  );
}
