/**
 * Job control HTTP routes — retry and cancel under `/api/v1`.
 */
import { cancelJob, retryJob } from './jobControl.service.js';
import { parseJobControlParams } from './jobControl.params.js';

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
