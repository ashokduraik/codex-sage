/**
 * Fastify preHandler factory: project visibility + effective permission check.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { hasRequiredPermissions } from '../../modules/access/index.js';
import { resolveProjectPermissions } from '../../modules/masters/index.js';

/** HTTP methods that carry resource ids in the JSON/multipart body (not the path). */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Creates a preHandler that enforces project ACL for project-scoped routes.
 * Call after global authenticate (`routeAccess: 'authenticated'`).
 * GET/HEAD read `projectId` from path params; mutating methods read it from the body.
 *
 * @param {string | string[]} permission Required permission key(s) from the effective set.
 * @param {{ mode?: 'all' | 'any' }} [options] Match mode (default all).
 * @returns {import('fastify').preHandlerAsyncHookHandler}
 */
export function requireProjectPermission(permission, options = {}) {
  const required = Array.isArray(permission) ? permission : [permission];
  const mode = options.mode ?? 'all';

  return async function projectPermissionPreHandler(request) {
    const principal = request.principal;
    if (!principal?.orgId || !principal?.userId) {
      throw ApiError.fromCode('UNAUTHENTICATED');
    }

    const method = String(request.method ?? '').toUpperCase();
    const projectId = MUTATING_METHODS.has(method)
      ? /** @type {{ projectId?: string }} */ (request.body)?.projectId
      : /** @type {{ projectId?: string }} */ (request.params)?.projectId;
    if (!projectId || !mongoose.isValidObjectId(projectId)) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'projectId', message: 'projectId must be a valid ObjectId' }],
      });
    }

    if (!request.projectAclMemo) {
      request.projectAclMemo = new Map();
    }

    const resolved = await resolveProjectPermissions(principal.orgId, principal.userId, projectId, { requestMemo: request.projectAclMemo });

    if (resolved.kind === 'NO_ACCESS') {
      throw ApiError.fromCode('PROJECT_NOT_FOUND');
    }

    if (!hasRequiredPermissions(resolved.permissions, required, mode)) {
      throw ApiError.fromCode('FORBIDDEN');
    }

    request.projectScope = {
      orgId: principal.orgId,
      projectId,
      userId: principal.userId,
      permissions: resolved.permissions,
    };
  };
}
