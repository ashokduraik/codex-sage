/**
 * Source file metadata and slice HTTP routes.
 */
import { z } from 'zod';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { loadSourceFileMetadata, loadSourceFileSlice } from './sourcePreview.service.js';

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

const metadataQuerySchema = z.object({
  path: z.string().min(1),
});

const sliceQuerySchema = metadataQuerySchema.extend({
  startLine: z.coerce.number().int(),
  endLine: z.coerce.number().int(),
});

/**
 * Registers preview routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function sourcePreviewRoutes(app) {
  const config = { routeAccess: 'authenticated' };
  const preHandler = requireProjectPermission('sources.preview');

  app.get(
    '/projects/:projectId/files/slice',
    { config, preHandler },
    async (request) => {
      const parsed = sliceQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      return loadSourceFileSlice({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        path: parsed.data.path,
        startLine: parsed.data.startLine,
        endLine: parsed.data.endLine,
      });
    },
  );

  app.get(
    '/projects/:projectId/files',
    { config, preHandler },
    async (request) => {
      const parsed = metadataQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      return loadSourceFileMetadata({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        path: parsed.data.path,
      });
    },
  );
}
