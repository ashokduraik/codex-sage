/**
 * Job control HTTP routes — retry and cancel under `/api/v1`.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { cancelJob, retryJob } from './jobControl.service.js';

const jobIdParamsSchema = z.object({
  jobId: z.string().min(1),
});

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
export function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || 'params',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Parses and validates `:jobId` route params.
 * @param {unknown} params Fastify request.params.
 * @returns {{ jobId: string }}
 * @throws {ApiError} VALIDATION_ERROR when invalid.
 */
export function parseJobControlParams(params) {
  const parsed = jobIdParamsSchema.safeParse(params ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  return parsed.data;
}

/**
 * Builds shared service context from the Fastify request.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {object}
 */
function controlContext(request) {
  return {
    orgId: /** @type {string} */ (request.principal.orgId),
    userId: /** @type {string} */ (request.principal.userId),
    correlationId: request.id,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    log: request.log,
    requestMemo: request.projectAclMemo,
  };
}

/**
 * Registers job control routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function jobControlRoutes(app) {
  app.post(
    '/jobs/:jobId/retry',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
    },
    async (request, reply) => {
      const params = parseJobControlParams(request.params);
      if (!request.projectAclMemo) {
        request.projectAclMemo = new Map();
      }
      const result = await retryJob({
        ...controlContext(request),
        jobId: params.jobId,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post(
    '/jobs/:jobId/cancel',
    {
      config: {
        routeAccess: 'authenticated',
      },
    },
    async (request, reply) => {
      const params = parseJobControlParams(request.params);
      if (!request.projectAclMemo) {
        request.projectAclMemo = new Map();
      }
      const result = await cancelJob({
        ...controlContext(request),
        jobId: params.jobId,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );
}
