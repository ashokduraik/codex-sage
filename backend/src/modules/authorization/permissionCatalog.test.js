import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_GROUPS,
  isKnownPermissionKey,
  toPermissionsApiPayload,
} from './permissionCatalog.js';

/** Exact solution §8.2 list — a silent addition must fail this test. */
const SOLUTION_8_2_KEYS = [
  'org.view',
  'org.manage',
  'users.manage',
  'roles.manage',
  'projects.create',
  'projects.view',
  'projects.update',
  'projects.delete',
  'sources.upload',
  'repos.connect',
  'knowledge.trigger',
  'knowledge.view',
  'chat.ask',
  'conversations.view',
  'conversations.archive',
  'conversations.search',
  'search.run',
  'knowledge.browse',
  'sources.preview',
  'audit.view',
  'usage.view',
  'settings.manage',
  'notifications.view',
];

describe('permissionCatalog', () => {
  it('contains exactly the 23 strings from solution §8.2', () => {
    expect(ALL_PERMISSION_KEYS).toHaveLength(23);
    expect([...ALL_PERMISSION_KEYS].sort()).toEqual([...SOLUTION_8_2_KEYS].sort());
  });

  it('has no duplicate keys and every entry has label and description', () => {
    const keys = [];
    for (const group of PERMISSION_GROUPS) {
      expect(group.id).toBeTruthy();
      expect(group.label).toBeTruthy();
      for (const entry of group.permissions) {
        keys.push(entry.key);
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
        expect(entry.label).not.toContain('.');
        expect(entry.label).not.toBe(entry.key);
      }
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('contains no database-query permission', () => {
    for (const key of ALL_PERMISSION_KEYS) {
      expect(key).not.toMatch(/database|query\.|db\./i);
    }
  });

  it('exposes isKnownPermissionKey and API payload shape', () => {
    expect(isKnownPermissionKey('org.view')).toBe(true);
    expect(isKnownPermissionKey('not.a.permission')).toBe(false);
    const payload = toPermissionsApiPayload();
    expect(payload.groups).toHaveLength(PERMISSION_GROUPS.length);
    expect(payload.groups[0].permissions[0]).toEqual(
      expect.objectContaining({
        key: 'org.view',
        label: expect.any(String),
        description: expect.any(String),
      }),
    );
  });
});
