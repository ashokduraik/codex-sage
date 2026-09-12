/**
 * Frontend mirror of the backend audit action / resource-type catalogs (Phase 10).
 * Keep in sync with backend/src/modules/audit/audit.actions.js when new actions ship.
 */

/** Known `<domain>.<verb>` audit actions offered in filter selects. */
export const AUDIT_ACTIONS = Object.freeze([
  'user.create',
  'user.update',
  'user.email_changed',
  'user.activate',
  'user.deactivate',
  'user.remove',
  'user.roles_changed',
  'user.password_changed',
  'user.password_set_by_admin',
  'role.create',
  'role.update',
  'role.remove',
  'membership.update',
  'authz.denied',
  'project.create',
  'project.update',
  'project.settings_changed',
  'project.archive',
  'project.restore',
  'project.delete',
]);

/** Known resource types paired with catalog actions. */
export const AUDIT_RESOURCE_TYPES = Object.freeze([
  'user',
  'role',
  'membership',
  'route',
  'project',
]);
