/**
 * Public surface of the access module (auth, permissions, audit).
 */
export {
  hashPassword,
  JWT_ACCESS_TOKEN_TTL_SECONDS,
  JWT_REFRESH_TOKEN_TTL_SECONDS,
  JWT_ISSUER,
  JWT_AUDIENCE,
  CSRF_SECRET_COOKIE_NAME,
  revokeAllLoginSessionsForUser,
  createAuthService,
  createAuthenticatePreHandler,
  authRoutes,
} from './auth.js';
export { PASSWORD_MIN_LENGTH, adminSetPassword, getPasswordResetStatus, passwordRoutes } from './password.js';
export {
  isKnownPermissionKey,
  assertRolePermissionsInCatalog,
  getBuiltInRolePermissions,
  invalidateRole,
  hasRequiredPermissions,
  resolveEffectivePermissions,
  createAuthorizePreHandler,
  assertAllRoutesDeclareAccess,
  installRouteDeclarationCollector,
  permissionsRoutes,
} from './permissions.js';
export { buildAuditContextFromRequest, recordAuditEvent, auditRoutes } from './audit.js';

import { AuditEvent } from '../../models/audit.model.js';
import { LoginSession } from '../../models/loginSession.model.js';

/** Models whose indexes are synced on development API startup. */
export const AUTH_MODELS = Object.freeze([LoginSession]);

/** Models owned by audit (index sync). */
export const AUDIT_MODELS = Object.freeze([AuditEvent]);
