/**
 * Global authorization preHandler: classify route → authenticate → permission check.
 */
import { ApiError } from '../../platform/errors.js';
import {
  buildAuditContextFromRequest,
  recordAuditEvent,
  shouldAuditAuthorizationDenial,
} from '../audit/index.js';
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
      const routeLabel = `${request.method} ${request.routeOptions?.url ?? request.url}`;
      const error = ApiError.fromCode('FORBIDDEN');
      // Non-client fields for audit/logs — never sent in the error envelope.
      error.authorizationDenial = {
        requiredPermissions: [...required],
        permissionMode: mode,
        principalUserId: principal.userId,
        route: routeLabel,
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

      if (shouldAuditAuthorizationDenial(required)) {
        const auditBase = buildAuditContextFromRequest(request);
        await recordAuditEvent(
          {
            ...auditBase,
            orgId: principal.orgId,
            actorUserId: principal.userId,
            action: 'authz.denied',
            resourceType: 'route',
            resourceId: routeLabel,
            result: 'denied',
            context: {
              requiredPermissions: required,
              permissionMode: mode,
            },
          },
          { log: request.log },
        );
      }

      throw error;
    }
  };
}
