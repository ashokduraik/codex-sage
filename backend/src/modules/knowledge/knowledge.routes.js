/**
 * Knowledge browse HTTP routes under `/api/v1/projects/:projectId/knowledge`.
 */
import { z } from 'zod';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { KNOWLEDGE_SYMBOL_QUERY_MIN_LEN, loadKnowledgeBrowse } from './knowledge.browse.service.js';

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});

const symbolsQuerySchema = listQuerySchema.extend({
  q: z.string().min(KNOWLEDGE_SYMBOL_QUERY_MIN_LEN),
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
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

const browsePreHandler = requireProjectPermission(['knowledge.browse', 'knowledge.view'], {
  mode: 'any',
});

/**
 * Shared GET handler after ACL.
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {'index' | 'summary' | 'workflows' | 'apis' | 'symbols' | 'health'} kind Browse kind.
 * @param {object} query Parsed query.
 * @returns {Promise<object>}
 */
async function handleBrowse(request, kind, query) {
  return loadKnowledgeBrowse({
    orgId: request.projectScope.orgId,
    projectId: request.projectScope.projectId,
    kind,
    workspaceRoot: request.server.config.workspace.root,
    query,
  });
}

/**
 * Registers knowledge browse routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function knowledgeBrowseRoutes(app) {
  const config = { routeAccess: 'authenticated' };

  app.get(
    '/projects/:projectId/knowledge/summary',
    { config, preHandler: browsePreHandler },
    async (request) => handleBrowse(request, 'summary', {}),
  );

  app.get(
    '/projects/:projectId/knowledge/workflows',
    { config, preHandler: browsePreHandler },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      return handleBrowse(request, 'workflows', parsed.data);
    },
  );

  app.get(
    '/projects/:projectId/knowledge/apis',
    { config, preHandler: browsePreHandler },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      return handleBrowse(request, 'apis', parsed.data);
    },
  );

  app.get(
    '/projects/:projectId/knowledge/symbols',
    { config, preHandler: browsePreHandler },
    async (request) => {
      const parsed = symbolsQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      return handleBrowse(request, 'symbols', parsed.data);
    },
  );

  app.get(
    '/projects/:projectId/knowledge/health',
    { config, preHandler: browsePreHandler },
    async (request) => handleBrowse(request, 'health', {}),
  );

  app.get(
    '/projects/:projectId/knowledge',
    { config, preHandler: browsePreHandler },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      return handleBrowse(request, 'index', parsed.data);
    },
  );
}
