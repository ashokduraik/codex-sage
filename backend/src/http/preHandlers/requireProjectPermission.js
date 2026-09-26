/**
 * Fastify preHandler factory: project visibility + effective permission check.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { hasRequiredPermissions } from '../../modules/access/index.js';
import { resolveProjectPermissions } from '../../modules/masters/index.js';

/**
 * Creates a preHandler that enforces project ACL for `:projectId` routes.
 * Call after global authenticate (`routeAccess: 'authenticated'`).
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

    const projectId = /** @type {{ projectId?: string }} */ (request.params)?.projectId;
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
