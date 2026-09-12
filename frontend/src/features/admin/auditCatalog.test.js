import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES } from './auditCatalog.js';

describe('auditCatalog', () => {
  it('mirrors the known action and resource-type vocabularies', () => {
    expect(AUDIT_ACTIONS).toContain('user.create');
    expect(AUDIT_ACTIONS).toContain('authz.denied');
    expect(AUDIT_RESOURCE_TYPES).toEqual(['user', 'role', 'membership', 'route']);
  });
});
