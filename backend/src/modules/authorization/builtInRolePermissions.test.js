import { describe, expect, it } from 'vitest';
import { BUILT_IN_ROLE_PERMISSIONS } from './builtInRolePermissions.js';
import { ALL_PERMISSION_KEYS } from './permissionCatalog.js';
import { hasRequiredPermissions } from './permissionResolver.js';

describe('builtInRolePermissions', () => {
  it('gives org_admin every catalog permission', () => {
    expect(BUILT_IN_ROLE_PERMISSIONS.org_admin).toEqual(ALL_PERMISSION_KEYS);
  });

  it('includes chat.ask on viewer', () => {
    expect(BUILT_IN_ROLE_PERMISSIONS.viewer).toContain('chat.ask');
  });

  it('gives member viewer permissions plus archive and upload', () => {
    for (const key of BUILT_IN_ROLE_PERMISSIONS.viewer) {
      expect(BUILT_IN_ROLE_PERMISSIONS.member).toContain(key);
    }
    expect(BUILT_IN_ROLE_PERMISSIONS.member).toContain('conversations.archive');
    expect(BUILT_IN_ROLE_PERMISSIONS.member).toContain('sources.upload');
  });
});

describe('hasRequiredPermissions', () => {
  it('requires all permissions by default', () => {
    expect(hasRequiredPermissions(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(hasRequiredPermissions(['a'], ['a', 'b'])).toBe(false);
  });

  it('passes any mode when one permission matches', () => {
    expect(hasRequiredPermissions(['b'], ['a', 'b'], 'any')).toBe(true);
    expect(hasRequiredPermissions(['c'], ['a', 'b'], 'any')).toBe(false);
  });

  it('denies an empty required list', () => {
    expect(hasRequiredPermissions(['a'], [])).toBe(false);
  });
});
