/**
 * Job HTTP read and control routes under `/api/v1`.
 */
import { z } from 'zod';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { JOB_STATUS_VALUES } from './jobs.constants.js';
import { getJobById, listProjectJobs } from './jobs.service.js';
import { jobControlRoutes } from './jobControl.routes.js';

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
  jobStatus: z.enum(JOB_STATUS_VALUES).optional(),
});

const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

const jobIdParamsSchema = z.object({
  jobId: z.string().min(1),
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

/**
 * Registers job read and control routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function jobRoutes(app) {
  await jobControlRoutes(app);

  app.get(
    '/projects/:projectId/jobs',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.view'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listProjectJobs(
        request.projectScope.orgId,
        request.projectScope.projectId,
        parsed.data,
      );
    },
  );

  app.get(
    '/jobs/:jobId',
    { config: { routeAccess: 'authenticated' } },
    async (request) => {
      const params = jobIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      return getJobById(
        /** @type {string} */ (request.principal.orgId),
        /** @type {string} */ (request.principal.userId),
        params.data.jobId,
        { requestMemo: request.projectAclMemo },
      );
    },
  );
}
