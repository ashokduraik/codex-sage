/**
 * Audit action catalog unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_RESOURCE_TYPES,
  AUDIT_ACTIONS,
  isKnownAuditAction,
  resourceTypeForAction,
} from './audit.actions.js';

describe('audit.actions', () => {
  it('exposes the curated action list', () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(AUDIT_ACTIONS).toHaveLength(Object.keys(AUDIT_ACTION_RESOURCE_TYPES).length);
  });

  it('recognizes known actions and rejects unknowns', () => {
    expect(isKnownAuditAction('user.password_changed')).toBe(true);
    expect(isKnownAuditAction('user.create')).toBe(true);
    expect(isKnownAuditAction('project.create')).toBe(true);
    expect(isKnownAuditAction('not.a.real.action')).toBe(false);
  });

  it('pairs each action with a resource type', () => {
    expect(resourceTypeForAction('user.password_changed')).toBe('user');
    expect(resourceTypeForAction('role.create')).toBe('role');
    expect(resourceTypeForAction('membership.update')).toBe('membership');
    expect(resourceTypeForAction('authz.denied')).toBe('route');
    expect(resourceTypeForAction('project.create')).toBe('project');
  });
});
