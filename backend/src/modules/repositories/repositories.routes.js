/**
 * Repository HTTP routes under `/api/v1`.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import {
  attachRepository,
  getRepositoryConnection,
  patchRepositoryBranch,
  replaceRepositoryCredential,
  retestRepositoryConnection,
  revokeRepositoryCredential,
} from './repositoryAttach.service.js';
import { enqueueManualRepositorySync } from './sync/repoSync.service.js';
import { probeRepository } from './repositoryProbe.service.js';
import {
  attachBodySchema,
  mapRepositoryZodDetails,
  patchBranchBodySchema,
  probeBodySchema,
  replaceCredentialBodySchema,
} from './repositories.schemas.js';

/**
 * Registers repository routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function repositoryRoutes(app) {
  app.post(
    '/projects/:projectId/repositories/probe',
    {
      config: {
        routeAccess: 'authenticated',
      },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      const parsed = probeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      const result = await probeRepository({
        repositoryUrl: parsed.data.repositoryUrl,
        accessToken: parsed.data.accessToken,
      });
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/projects/:projectId/repositories',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      const parsed = attachBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      const result = await attachRepository({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        repositoryUrl: parsed.data.repositoryUrl,
        selectedBranch: parsed.data.selectedBranch,
        accessToken: parsed.data.accessToken,
        correlationId: request.id,
        log: request.log,
      });
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/projects/:projectId/repositories/sync',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      const result = await enqueueManualRepositorySync({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        correlationId: request.id,
        log: request.log,
      });
      return reply.code(202).send(result);
    },
  );

  app.get(
    '/projects/:projectId/repositories/connection',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission(['projects.view', 'repos.connect'], {
        mode: 'any',
      }),
    },
    async (request) => {
      return getRepositoryConnection(
        request.projectScope.orgId,
        request.projectScope.projectId,
      );
    },
  );

  app.patch(
    '/projects/:projectId/repositories/connection/branch',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request) => {
      const parsed = patchBranchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      return patchRepositoryBranch({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        selectedBranch: parsed.data.selectedBranch,
        correlationId: request.id,
        log: request.log,
      });
    },
  );

  app.post(
    '/projects/:projectId/repositories/credentials/replace',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request) => {
      const parsed = replaceCredentialBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      return replaceRepositoryCredential({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        accessToken: parsed.data.accessToken,
        correlationId: request.id,
        log: request.log,
      });
    },
  );

  app.post(
    '/projects/:projectId/repositories/credentials/revoke',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      await revokeRepositoryCredential({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        correlationId: request.id,
        log: request.log,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/projects/:projectId/repositories/connection/re-test',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request) => {
      return retestRepositoryConnection({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
      });
    },
  );
}
