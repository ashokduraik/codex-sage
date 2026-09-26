/**
 * Public surface of the access module (auth, permissions, audit).
 */
export {
  hashPassword,
  verifyPassword,
  needsRehash,
  getDummyPasswordHash,
  ARGON2_MEMORY_COST_KIB,
  ARGON2_TIME_COST,
  ARGON2_PARALLELISM,
  createTokenService,
  mintRefreshToken,
  hashRefreshToken,
  hashEmailForLog,
  JWT_ACCESS_TOKEN_TTL_SECONDS,
  JWT_REFRESH_TOKEN_TTL_SECONDS,
  JWT_ISSUER,
  JWT_AUDIENCE,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  CSRF_COOKIE_NAME,
  CSRF_SECRET_COOKIE_NAME,
  CSRF_READABLE_COOKIE_PATH,
  createLoginSession,
  findLoginSessionByRefreshTokenHash,
  findLoginSessionById,
  isLoginSessionActiveForAccess,
  isLoginSessionActiveForRefresh,
  rotateLoginSession,
  revokeLoginSession,
  revokeAllLoginSessionsForUser,
  createAuthService,
  createAuthenticatePreHandler,
  authRoutes,
} from './auth.js';
export {
  LoginSession,
  LOGIN_SESSION_REVOKED_REASONS,
} from '../../models/loginSession.model.js';
export {
  PASSWORD_MIN_LENGTH,
  PASSWORD_HISTORY_LENGTH,
  validatePasswordCandidate,
  applyNewPassword,
  changeOwnPassword,
  adminSetPassword,
  getPasswordResetStatus,
  passwordRoutes,
} from './password.js';
export {
  ALL_PERMISSION_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_KEY_SET,
  isKnownPermissionKey,
  toPermissionsApiPayload,
  assertRolePermissionsInCatalog,
  BUILT_IN_ROLE_PERMISSIONS,
  getBuiltInRolePermissions,
  RBAC_ROLE_CACHE_MAX_ENTRIES,
  RBAC_ROLE_CACHE_TTL_SECONDS,
  createRoleCache,
  invalidateOrganization,
  invalidateRole,
  roleCache,
  hasRequiredPermissions,
  resolveEffectivePermissions,
  createAuthorizePreHandler,
  PUBLIC_ROUTE_PATHS,
  assertAllRoutesDeclareAccess,
  classifyRouteAccess,
  installRouteDeclarationCollector,
  isPublicAllowlistedPath,
  normalizeRoutePath,
  permissionsRoutes,
} from './permissions.js';
export {
  AUDIT_ACTIONS,
  AUDIT_ACTION_RESOURCE_TYPES,
  isKnownAuditAction,
  resourceTypeForAction,
  AUDIT_CONTEXT_MAX_BYTES,
  AUDIT_CONTEXT_MAX_VALUE_CHARS,
  AUDIT_USER_AGENT_MAX_CHARS,
  sanitizeAuditContext,
  sanitizeUserAgent,
  AUDIT_LIST_PAGE_SIZE_DEFAULT,
  AUDIT_LIST_PAGE_SIZE_MAX,
  clampAuditListLimit,
  insertAuditEvent,
  listAuditEvents,
  findAuditEventById,
  AUDITED_DENIAL_PERMISSION_KEYS,
  buildAuditContextFromRequest,
  getAuditEventForOrg,
  listAuditEventsForOrg,
  recordAuditEvent,
  shouldAuditAuthorizationDenial,
  auditRoutes,
} from './audit.js';
export { AuditEvent, AUDIT_RESULT_VALUES } from '../../models/audit.model.js';

import { AuditEvent } from '../../models/audit.model.js';
import { LoginSession } from '../../models/loginSession.model.js';

/** Models whose indexes are synced on development API startup. */
export const AUTH_MODELS = Object.freeze([LoginSession]);

/** Models owned by audit (index sync). */
export const AUDIT_MODELS = Object.freeze([AuditEvent]);
