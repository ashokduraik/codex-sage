/**
 * Global authorization preHandler: classify route → authenticate → permission check.
 */
import { ApiError } from '../../platform/errors.js';
import {
  hasRequiredPermissions,
  resolveEffectivePermissions,
} from './permissionResolver.js';
import {
  classifyRouteAccess,
  normalizeRoutePath,
} from './routeDeclarationAudit.js';

/**
 * Builds the app-level authorize preHandler bound to authenticate.
 * @param {(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>} authenticate AuthN preHandler.
 * @returns {(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 */
export function createAuthorizePreHandler(authenticate) {
  /**
   * Enforces route access class and optional required permissions.
   * @param {import('fastify').FastifyRequest} request Incoming request.
   * @param {import('fastify').FastifyReply} reply Reply (passed to authenticate).
   * @returns {Promise<void>}
   */
  return async function authorize(request, reply) {
    const config = /** @type {import('./routeDeclarationAudit.js').RouteAccessConfig | undefined} */ (
      request.routeOptions?.config
    );
    const normalized = normalizeRoutePath(request.routeOptions?.url ?? request.url);
    const classification = classifyRouteAccess(config, normalized);

    if (classification === 'public') {
      return;
    }
    if (classification === 'undeclared') {
      // Boot audit should have failed; deny closed if something slipped through.
      throw ApiError.fromCode('FORBIDDEN');
    }

    await authenticate(request, reply);

    if (classification === 'authenticated') {
      return;
    }

    const required = config?.requiredPermissions ?? [];
    const mode = config?.permissionMode === 'any' ? 'any' : 'all';
    const principal = request.principal;
    const effective = await resolveEffectivePermissions(principal.orgId, principal.roleIds);

    if (!hasRequiredPermissions(effective, required, mode)) {
      const error = ApiError.fromCode('FORBIDDEN');
      // Phase 10 reads these fields from logs/error handler — never sent to the client.
      error.authorizationDenial = {
        requiredPermissions: [...required],
        permissionMode: mode,
        principalUserId: principal.userId,
        route: `${request.method} ${request.routeOptions?.url ?? request.url}`,
        decision: 'deny',
      };
      request.log.warn(
        {
          requiredPermissions: required,
          permissionMode: mode,
          principalUserId: principal.userId,
          decision: 'deny',
        },
        'authorization denied',
      );
      throw error;
    }
  };
}
