/**
 * Code-resolved permission maps for built-in roles (Phase 06 stores empty arrays in Mongo).
 */
import { ALL_PERMISSION_KEYS } from './permissionCatalog.js';

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
