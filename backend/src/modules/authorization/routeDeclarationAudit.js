/**
 * Boot-time route declaration audit and public allowlist.
 * Every registered route must declare routeAccess or requiredPermissions.
 */

/** Paths that need no authentication (relative to their mount prefix). */
export const PUBLIC_ROUTE_PATHS = Object.freeze([
  '/health',
  '/readiness',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
]);

/**
 * @typedef {object} RouteAccessConfig
 * @property {'public' | 'authenticated'} [routeAccess]
 * @property {string[]} [requiredPermissions]
 * @property {'all' | 'any'} [permissionMode]
 */

/**
 * Normalizes a Fastify route path for allowlist comparison.
 * @param {string} path Route path (may include prefix).
 * @returns {string}
 */
export function normalizeRoutePath(path) {
  if (!path || path === '') {
    return '/';
  }
  const withoutQuery = path.split('?')[0];
  const stripped = withoutQuery.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  if (stripped.length > 1 && stripped.endsWith('/')) {
    return stripped.slice(0, -1);
  }
  return stripped;
}

/**
 * Returns whether a normalized path is on the public allowlist.
 * @param {string} normalizedPath Path from {@link normalizeRoutePath}.
 * @returns {boolean}
 */
export function isPublicAllowlistedPath(normalizedPath) {
  return PUBLIC_ROUTE_PATHS.includes(normalizedPath);
}

/**
 * Classifies a route config into an access mode.
 * @param {RouteAccessConfig | undefined} config Route config.
 * @param {string} normalizedPath Normalized route path.
 * @returns {'public' | 'authenticated' | 'permissions' | 'undeclared'}
 */
export function classifyRouteAccess(config, normalizedPath) {
  const required = config?.requiredPermissions;
  const hasRequired = Array.isArray(required) && required.length > 0;
  const routeAccess = config?.routeAccess;

  if (hasRequired && routeAccess) {
    return 'undeclared';
  }
  if (hasRequired) {
    return 'permissions';
  }
  if (routeAccess === 'public') {
    return 'public';
  }
  if (routeAccess === 'authenticated') {
    return 'authenticated';
  }
  if (isPublicAllowlistedPath(normalizedPath)) {
    return 'public';
  }
  return 'undeclared';
}

/**
 * Audits one route entry.
 * @param {{ method: string | string[], url: string, config?: RouteAccessConfig }} entry Route.
 * @param {Array<{ method: string, url: string, reason: string }>} failures Failure sink.
 */
function auditOneRoute(entry, failures) {
  const methods = Array.isArray(entry.method) ? entry.method : [entry.method];
  const normalized = normalizeRoutePath(entry.url);
  for (const method of methods) {
    const upper = String(method).toUpperCase();
    if (upper === 'HEAD' || upper === 'OPTIONS') {
      continue;
    }
    const classification = classifyRouteAccess(entry.config, normalized);
    if (classification === 'undeclared') {
      failures.push({
        method: upper,
        url: entry.url,
        reason: 'missing routeAccess or requiredPermissions',
      });
    }
  }
}

/**
 * Asserts every collected route declares an access class.
 * @param {import('fastify').FastifyInstance} app Fastify instance after routes are registered.
 * @throws {Error} When any route is undeclared or has conflicting config.
 */
export function assertAllRoutesDeclareAccess(app) {
  const collected = app.authorizationRouteRegistry;
  if (!Array.isArray(collected) || collected.length === 0) {
    throw new Error(
      'Route declaration audit found no routes — ensure onRoute registry is installed.',
    );
  }

  /** @type {Array<{ method: string, url: string, reason: string }>} */
  const failures = [];
  for (const entry of collected) {
    auditOneRoute(entry, failures);
  }

  if (failures.length > 0) {
    const detail = failures
      .map((item) => `${item.method} ${item.url}: ${item.reason}`)
      .join('; ');
    throw new Error(`Route declaration audit failed: ${detail}`);
  }
}

/**
 * Installs an onRoute collector used by the boot audit.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export function installRouteDeclarationCollector(app) {
  if (!app.hasDecorator('authorizationRouteRegistry')) {
    app.decorate('authorizationRouteRegistry', []);
  }
  app.addHook('onRoute', (routeOptions) => {
    app.authorizationRouteRegistry.push({
      method: routeOptions.method,
      url: routeOptions.url,
      config: routeOptions.config,
    });
  });
}
