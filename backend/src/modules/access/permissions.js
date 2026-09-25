/**
 * access/permissions.js — merged resource file.
 */
import { Role } from '../../models/role.model.js';
import { ApiError } from '../../platform/errors.js';
import {
  buildAuditContextFromRequest,
  recordAuditEvent,
  shouldAuditAuthorizationDenial,
} from './audit.js';

// --- from authorization/permissionCatalog.js ---
/**
 * Product permission catalog — single source of truth (solution §8.2).
 * Keys travel in API payloads as opaque values; UI renders label/description only.
 */

/**
 * @typedef {object} PermissionEntry
 * @property {string} key
 * @property {string} label
 * @property {string} description
 */

/**
 * @typedef {object} PermissionGroup
 * @property {string} id
 * @property {string} label
 * @property {ReadonlyArray<PermissionEntry>} permissions
 */

/** Ordered permission groups matching solution §8.2. */
export const PERMISSION_GROUPS = Object.freeze([
  Object.freeze({
    id: 'organization',
    label: 'Organization',
    permissions: Object.freeze([
      Object.freeze({
        key: 'org.view',
        label: 'View organization',
        description: 'Can view organization details, users and roles.',
      }),
      Object.freeze({
        key: 'org.manage',
        label: 'Manage organization',
        description: 'Can change organization details and settings.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'users_and_roles',
    label: 'Users and roles',
    permissions: Object.freeze([
      Object.freeze({
        key: 'users.manage',
        label: 'Manage users',
        description: 'Can invite, activate, deactivate and reset user credentials.',
      }),
      Object.freeze({
        key: 'roles.manage',
        label: 'Manage roles',
        description: 'Can create and edit custom roles and their permissions.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'projects',
    label: 'Projects',
    permissions: Object.freeze([
      Object.freeze({
        key: 'projects.create',
        label: 'Create projects',
        description: 'Can create new projects in the organization.',
      }),
      Object.freeze({
        key: 'projects.view',
        label: 'View projects',
        description: 'Can view project details and listings.',
      }),
      Object.freeze({
        key: 'projects.update',
        label: 'Update projects',
        description: 'Can change project settings and metadata.',
      }),
      Object.freeze({
        key: 'projects.delete',
        label: 'Delete projects',
        description: 'Can soft-delete projects.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'sources',
    label: 'Sources',
    permissions: Object.freeze([
      Object.freeze({
        key: 'sources.upload',
        label: 'Upload sources',
        description: 'Can upload project sources.',
      }),
      Object.freeze({
        key: 'repos.connect',
        label: 'Connect repositories',
        description: 'Can connect Git repositories as project sources.',
      }),
      Object.freeze({
        key: 'sources.preview',
        label: 'Preview sources',
        description: 'Can preview uploaded or connected source content.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'knowledge',
    label: 'Knowledge',
    permissions: Object.freeze([
      Object.freeze({
        key: 'knowledge.trigger',
        label: 'Trigger knowledge updates',
        description: 'Can start knowledge build and refresh jobs.',
      }),
      Object.freeze({
        key: 'knowledge.view',
        label: 'View knowledge',
        description: 'Can view knowledge status and summaries.',
      }),
      Object.freeze({
        key: 'knowledge.browse',
        label: 'Browse knowledge',
        description: 'Can browse the project knowledge tree.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'chat',
    label: 'Chat',
    permissions: Object.freeze([
      Object.freeze({
        key: 'chat.ask',
        label: 'Ask questions',
        description: 'Can ask grounded questions in project chat.',
      }),
      Object.freeze({
        key: 'conversations.view',
        label: 'View conversations',
        description: 'Can view conversation history.',
      }),
      Object.freeze({
        key: 'conversations.archive',
        label: 'Archive conversations',
        description: 'Can archive and restore conversations.',
      }),
      Object.freeze({
        key: 'conversations.search',
        label: 'Search conversations',
        description: 'Can search conversation content.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'search',
    label: 'Search',
    permissions: Object.freeze([
      Object.freeze({
        key: 'search.run',
        label: 'Run search',
        description: 'Can run project search.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'administration',
    label: 'Administration',
    permissions: Object.freeze([
      Object.freeze({
        key: 'settings.manage',
        label: 'Manage settings',
        description: 'Can change organization and product settings.',
      }),
      Object.freeze({
        key: 'audit.view',
        label: 'View audit log',
        description: 'Can view audit events.',
      }),
      Object.freeze({
        key: 'usage.view',
        label: 'View usage',
        description: 'Can view usage metrics.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'notifications',
    label: 'Notifications',
    permissions: Object.freeze([
      Object.freeze({
        key: 'notifications.view',
        label: 'View notifications',
        description: 'Can view notifications.',
      }),
    ]),
  }),
]);

/** Flat list of every catalog permission key (solution §8.2 order). */
export const ALL_PERMISSION_KEYS = Object.freeze(
  PERMISSION_GROUPS.flatMap((group) => group.permissions.map((entry) => entry.key)),
);

/** Set for O(1) membership checks. */
export const PERMISSION_KEY_SET = Object.freeze(new Set(ALL_PERMISSION_KEYS));

/**
 * Returns whether `key` is a known catalog permission.
 * @param {string} key Candidate permission key.
 * @returns {boolean}
 */
export function isKnownPermissionKey(key) {
  return PERMISSION_KEY_SET.has(key);
}

/**
 * Builds the API payload for GET /permissions.
 * @returns {{ groups: Array<{ id: string, label: string, permissions: PermissionEntry[] }> }}
 */
export function toPermissionsApiPayload() {
  return {
    groups: PERMISSION_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      permissions: group.permissions.map((entry) => ({
        key: entry.key,
        label: entry.label,
        description: entry.description,
      })),
    })),
  };
}

/**
 * Scans active roles for permission keys missing from the catalog.
 * Built-in roles store empty arrays; unknown custom keys fail startup.
 * @returns {Promise<void>}
 * @throws {Error} When any stored permission is unknown.
 */
export async function assertRolePermissionsInCatalog() {
  const { Role } = await import('../../models/role.model.js');
  const roles = await Role.find({}).select({ permissions: 1, name: 1, orgId: 1 }).exec();
  /** @type {string[]} */
  const unknown = [];
  for (const role of roles) {
    const permissions = Array.isArray(role.permissions) ? role.permissions : [];
    for (const key of permissions) {
      if (typeof key === 'string' && key.length > 0 && !isKnownPermissionKey(key)) {
        unknown.push(`${role.orgId}/${role.name}:${key}`);
      }
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Role permission catalog drift: unknown keys ${unknown.slice(0, 20).join(', ')}`,
    );
  }
}

/** Shared read + ask surface for viewer and above. */
const VIEWER_PERMISSIONS = Object.freeze([
  'org.view',
  'projects.view',
  'knowledge.view',
  'knowledge.browse',
  'sources.preview',
  'chat.ask',
  'conversations.view',
  'conversations.search',
  'search.run',
  'notifications.view',
]);

/** Standard member: viewer plus upload and conversation archive. */
const MEMBER_PERMISSIONS = Object.freeze([
  ...VIEWER_PERMISSIONS,
  'conversations.archive',
  'sources.upload',
]);

/** Project admin: member plus project/source/knowledge write capabilities. */
const PROJECT_ADMIN_PERMISSIONS = Object.freeze([
  ...MEMBER_PERMISSIONS,
  'projects.create',
  'projects.update',
  'projects.delete',
  'repos.connect',
  'knowledge.trigger',
]);

/**
 * Map of builtInKey → frozen permission array.
 * Built-in roles store empty arrays in Mongo; permissions resolve from this map.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const BUILT_IN_ROLE_PERMISSIONS = Object.freeze({
  org_admin: ALL_PERMISSION_KEYS,
  project_admin: PROJECT_ADMIN_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
});

/**
 * Returns the code-resolved permission list for a built-in role key.
 * @param {string} builtInKey Built-in role key.
 * @returns {ReadonlyArray<string> | undefined}
 */
export function getBuiltInRolePermissions(builtInKey) {
  return BUILT_IN_ROLE_PERMISSIONS[builtInKey];
}

// --- from authorization/roleCache.js ---
/**
 * In-process TTL cache for role id → permission array.
 * Cross-process edits converge within RBAC_ROLE_CACHE_TTL_SECONDS.
 */

/** Worst-case staleness after a role edit on another API process (seconds). */
export const RBAC_ROLE_CACHE_TTL_SECONDS = 30;

/** Upper bound on cached role entries. */
export const RBAC_ROLE_CACHE_MAX_ENTRIES = 500;

/**
 * @typedef {object} RoleCacheEntry
 * @property {ReadonlyArray<string>} permissions
 * @property {number} expiresAtMs
 */

/**
 * Creates a role-permission cache.
 * @param {{
 *   ttlSeconds?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 * }} [options] Optional overrides for tests.
 * @returns {{
 *   get: (orgId: string, roleId: string) => ReadonlyArray<string> | undefined,
 *   set: (orgId: string, roleId: string, permissions: ReadonlyArray<string>) => void,
 *   invalidateRole: (orgId: string, roleId: string) => void,
 *   invalidateOrganization: (orgId: string) => void,
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
export function createRoleCache(options = {}) {
  const ttlSeconds = options.ttlSeconds ?? RBAC_ROLE_CACHE_TTL_SECONDS;
  const maxEntries = options.maxEntries ?? RBAC_ROLE_CACHE_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  /** @type {Map<string, RoleCacheEntry>} */
  const store = new Map();

  /**
   * Builds a cache key.
   * @param {string} orgId Tenant id.
   * @param {string} roleId Role id.
   * @returns {string}
   */
  function cacheKey(orgId, roleId) {
    return `${orgId}:${roleId}`;
  }

  /**
   * Evicts expired entries and, if still over capacity, the oldest inserted key.
   */
  function evictIfNeeded() {
    const currentMs = now();
    for (const [key, entry] of store) {
      if (entry.expiresAtMs <= currentMs) {
        store.delete(key);
      }
    }
    while (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      store.delete(oldestKey);
    }
  }

  return {
    /**
     * Returns cached permissions when present and unexpired.
     * @param {string} orgId Tenant id.
     * @param {string} roleId Role id.
     * @returns {ReadonlyArray<string> | undefined}
     */
    get(orgId, roleId) {
      const key = cacheKey(orgId, roleId);
      const entry = store.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAtMs <= now()) {
        store.delete(key);
        return undefined;
      }
      // Refresh insertion order for simple LRU-ish eviction.
      store.delete(key);
      store.set(key, entry);
      return entry.permissions;
    },

    /**
     * Stores permissions for a role.
     * @param {string} orgId Tenant id.
     * @param {string} roleId Role id.
     * @param {ReadonlyArray<string>} permissions Effective permission keys.
     */
    set(orgId, roleId, permissions) {
      evictIfNeeded();
      const key = cacheKey(orgId, roleId);
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) {
          store.delete(oldestKey);
        }
      }
      store.set(key, {
        permissions: Object.freeze([...permissions]),
        expiresAtMs: now() + ttlSeconds * 1000,
      });
    },

    /**
     * Drops one role from the cache (call after a role write).
     * @param {string} orgId Tenant id.
     * @param {string} roleId Role id.
     */
    invalidateRole(orgId, roleId) {
      store.delete(cacheKey(orgId, roleId));
    },

    /**
     * Drops every cached role for an organization.
     * @param {string} orgId Tenant id.
     */
    invalidateOrganization(orgId) {
      const prefix = `${orgId}:`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },

    /**
     * @returns {number} Current entry count.
     */
    size() {
      return store.size;
    },

    /**
     * Clears the entire cache (tests).
     */
    clear() {
      store.clear();
    },
  };
}

/** Process-wide default cache used by the permission resolver. */
export const roleCache = createRoleCache();

/**
 * Invalidates one cached role (Phase 11 calls after role writes).
 * @param {string} orgId Tenant id.
 * @param {string} roleId Role id.
 */
export function invalidateRole(orgId, roleId) {
  roleCache.invalidateRole(orgId, roleId);
}

/**
 * Invalidates every cached role for an organization.
 * @param {string} orgId Tenant id.
 */
export function invalidateOrganization(orgId) {
  roleCache.invalidateOrganization(orgId);
}

// --- from authorization/permissionResolver.js ---
/**
 * Resolves role ids to an effective permission set for one organization.
 */
/**
 * Loads permission keys for one role document (built-in from code, custom from DB).
 * @param {{ isBuiltIn?: boolean, builtInKey?: string | null, permissions?: string[] }} role Role doc.
 * @returns {string[]}
 */
function permissionsForRoleDocument(role) {
  if (role.isBuiltIn && role.builtInKey) {
    const fromCode = getBuiltInRolePermissions(role.builtInKey);
    if (fromCode) {
      return [...fromCode];
    }
  }
  const stored = Array.isArray(role.permissions) ? role.permissions : [];
  return stored.filter((key) => typeof key === 'string' && isKnownPermissionKey(key));
}

/**
 * Resolves effective permissions for role ids scoped to an organization.
 * Role ids that do not match an active role in the org contribute nothing.
 * @param {string} orgId Tenant id from the principal (never from the client).
 * @param {string[]} roleIds Role id strings.
 * @param {{ cache?: typeof roleCache }} [options] Optional cache override for tests.
 * @returns {Promise<string[]>} Deduplicated permission keys.
 */
export async function resolveEffectivePermissions(orgId, roleIds, options = {}) {
  const cache = options.cache ?? roleCache;
  if (!orgId || !Array.isArray(roleIds) || roleIds.length === 0) {
    return [];
  }

  const uniqueRoleIds = [...new Set(roleIds.map(String).filter(Boolean))];
  /** @type {string[]} */
  const collected = [];
  /** @type {string[]} */
  const missingIds = [];

  for (const roleId of uniqueRoleIds) {
    const cached = cache.get(orgId, roleId);
    if (cached) {
      collected.push(...cached);
    } else {
      missingIds.push(roleId);
    }
  }

  if (missingIds.length > 0) {
    const roles = await Role.find({
      _id: { $in: missingIds },
      orgId,
    }).exec();

    const foundIds = new Set(roles.map((role) => String(role._id)));
    for (const role of roles) {
      const permissions = permissionsForRoleDocument(role);
      cache.set(orgId, String(role._id), permissions);
      collected.push(...permissions);
    }
    // Cache empty arrays for unknown ids so we do not re-query within the TTL.
    for (const roleId of missingIds) {
      if (!foundIds.has(roleId)) {
        cache.set(orgId, roleId, []);
      }
    }
  }

  return [...new Set(collected)];
}

/**
 * Returns whether the effective set satisfies the required permissions.
 * @param {Iterable<string>} effective Caller permissions.
 * @param {string[]} required Required permission keys.
 * @param {'all' | 'any'} [mode] Match mode (default all).
 * @returns {boolean}
 */
export function hasRequiredPermissions(effective, required, mode = 'all') {
  const set = effective instanceof Set ? effective : new Set(effective);
  if (!required.length) {
    return false;
  }
  if (mode === 'any') {
    return required.some((key) => set.has(key));
  }
  return required.every((key) => set.has(key));
}

// --- from authorization/routeDeclarationAudit.js ---
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
 * @property {unknown} [file] Set by `@fastify/static` for served asset routes.
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
  // Static SPA / asset routes from `@fastify/static` carry `config.file`.
  if (config?.file !== undefined) {
    return 'public';
  }

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

// --- from authorization/authorize.preHandler.js ---
/**
 * Global authorization preHandler: classify route → authenticate → permission check.
 */
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

// --- from authorization/permissions.routes.js ---
/**
 * Permission catalog HTTP routes.
 */
/**
 * Registers `GET /permissions`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function permissionsRoutes(app) {
  app.get(
    '/permissions',
    {
      config: {
        requiredPermissions: ['roles.manage'],
      },
    },
    async () => toPermissionsApiPayload(),
  );
}
