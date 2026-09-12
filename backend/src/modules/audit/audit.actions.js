/**
 * Curated audit action catalog — free-text actions are rejected at write time.
 * Later phases add entries in the same change that introduces their routes.
 */

/** @typedef {'user' | 'role' | 'membership' | 'route' | 'project' | 'job'} AuditResourceType */

/**
 * Map of known `<domain>.<verb>` actions to their paired resourceType.
 * @type {Readonly<Record<string, AuditResourceType>>}
 */
export const AUDIT_ACTION_RESOURCE_TYPES = Object.freeze({
  'user.create': 'user',
  'user.update': 'user',
  'user.email_changed': 'user',
  'user.activate': 'user',
  'user.deactivate': 'user',
  'user.remove': 'user',
  'user.roles_changed': 'user',
  'user.password_changed': 'user',
  'user.password_set_by_admin': 'user',
  'role.create': 'role',
  'role.update': 'role',
  'role.remove': 'role',
  'membership.update': 'membership',
  'authz.denied': 'route',
  'project.create': 'project',
  'project.update': 'project',
  'project.settings_changed': 'project',
  'project.archive': 'project',
  'project.restore': 'project',
  'project.delete': 'project',
  'project.member_added': 'project',
  'project.member_removed': 'project',
  'job.retry': 'job',
  'job.cancel': 'job',
});

/** Frozen list of known action strings. */
export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_ACTION_RESOURCE_TYPES));

/** Set for O(1) membership checks. */
const AUDIT_ACTION_SET = new Set(AUDIT_ACTIONS);

/**
 * Returns whether `action` is a known catalog entry.
 * @param {string} action Candidate action.
 * @returns {boolean}
 */
export function isKnownAuditAction(action) {
  return typeof action === 'string' && AUDIT_ACTION_SET.has(action);
}

/**
 * Returns the resourceType paired with a known action.
 * @param {string} action Catalog action.
 * @returns {AuditResourceType | undefined}
 */
export function resourceTypeForAction(action) {
  return AUDIT_ACTION_RESOURCE_TYPES[action];
}
