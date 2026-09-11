/**
 * Unit tests for the audit action catalog.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  isKnownAuditAction,
  resourceTypeForAction,
} from './audit.actions.js';

describe('audit.actions', () => {
  it('exposes seeded password and authz actions', () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'user.password_changed',
        'user.password_set_by_admin',
        'authz.denied',
      ]),
    );
  });

  it('rejects unknown action strings at runtime', () => {
    expect(isKnownAuditAction('user.password_changed')).toBe(true);
    expect(isKnownAuditAction('user.invented')).toBe(false);
    expect(isKnownAuditAction('')).toBe(false);
  });

  it('pairs each known action with a resourceType', () => {
    expect(resourceTypeForAction('user.password_changed')).toBe('user');
    expect(resourceTypeForAction('user.password_set_by_admin')).toBe('user');
    expect(resourceTypeForAction('authz.denied')).toBe('route');
    expect(resourceTypeForAction('missing')).toBeUndefined();
  });
});
