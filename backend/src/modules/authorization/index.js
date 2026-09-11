/**
 * Authorization module public surface.
 */
export {
  ALL_PERMISSION_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_KEY_SET,
  isKnownPermissionKey,
  toPermissionsApiPayload,
} from './permissionCatalog.js';
export {
  BUILT_IN_ROLE_PERMISSIONS,
  getBuiltInRolePermissions,
} from './builtInRolePermissions.js';
export {
  RBAC_ROLE_CACHE_MAX_ENTRIES,
  RBAC_ROLE_CACHE_TTL_SECONDS,
  createRoleCache,
  invalidateOrganization,
  invalidateRole,
  roleCache,
} from './roleCache.js';
export {
  hasRequiredPermissions,
  resolveEffectivePermissions,
} from './permissionResolver.js';
export { createAuthorizePreHandler } from './authorize.preHandler.js';
export { assertOrganizationPathMatchesPrincipal } from './organizationScope.js';
export {
  PUBLIC_ROUTE_PATHS,
  assertAllRoutesDeclareAccess,
  classifyRouteAccess,
  installRouteDeclarationCollector,
  isPublicAllowlistedPath,
  normalizeRoutePath,
} from './routeDeclarationAudit.js';
export { assertRolePermissionsInCatalog } from './roleCatalogAudit.js';
export { permissionsRoutes } from './permissions.routes.js';
