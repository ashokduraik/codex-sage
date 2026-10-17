/**
 * Public surface of the access module (auth, permissions, audit).
 */
import { AuditEvent } from '../../models/audit.model.js';
import { LoginSession } from '../../models/loginSession.model.js';

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
  loginHttp,
  refreshSessionHttp,
  logoutHttp,
  getCurrentUserHttp,
} from './auth.js';
export { PASSWORD_MIN_LENGTH, adminSetPassword, getPasswordResetStatus, changeOwnPasswordHttp } from './password.js';
export {
  isKnownPermissionKey,
  assertRolePermissionsInCatalog,
  ALL_PERMISSION_KEYS,
  invalidateRole,
  hasRequiredPermissions,
  resolveEffectivePermissions,
  createAuthorizePreHandler,
  assertAllRoutesDeclareAccess,
  installRouteDeclarationCollector,
  listPermissionsHttp,
} from './permissions.js';
export { buildAuditContextFromRequest, recordAuditEvent, listAuditEventsHttp, getAuditEventHttp } from './audit.js';

/** Models whose indexes are synced on development API startup. */
export const AUTH_MODELS = Object.freeze([LoginSession]);

/** Models owned by audit (index sync). */
export const AUDIT_MODELS = Object.freeze([AuditEvent]);
