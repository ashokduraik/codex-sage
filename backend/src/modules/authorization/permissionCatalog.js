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
  const { Role } = await import('../identity/role.model.js');
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
