/**
 * Source upload HTTP routes under `/api/v1`.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { buildAuditContextFromRequest } from '../audit/index.js';
import { persistSourceUpload } from './upload.service.js';

/**
 * Registers source upload routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function sourceUploadRoutes(app) {
  app.post(
    '/projects/:projectId/sources',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
        consumeSourceArchive: true,
      },
      preHandler: requireProjectPermission('sources.upload'),
    },
    async (request, reply) => {
      // consumeSourceArchivePreHandler always attaches buffer when this route runs.
      const upload = request.sourceUpload;
      const audit = buildAuditContextFromRequest(request);
      const result = await persistSourceUpload({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        correlationId: audit.correlationId,
        archiveBuffer: upload.buffer,
        ip: audit.ip,
        userAgent: audit.userAgent,
        log: request.log,
      });

      return reply.code(202).send(result);
    },
  );
}
