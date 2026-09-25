import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { IDENTITY_MODELS, createOrganization } from '../../../src/modules/masters/index.js';
import { Role } from '../../../src/models/role.model.js';
import {
  ALL_PERMISSION_KEYS,
  BUILT_IN_ROLE_PERMISSIONS,
  PERMISSION_GROUPS,
  assertRolePermissionsInCatalog,
  isKnownPermissionKey,
  toPermissionsApiPayload,
} from '../../../src/modules/access/permissions.js';

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

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('assertRolePermissionsInCatalog', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('passes when every stored permission is in the catalog', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    await Role.create({
      orgId: org._id,
      name: 'Ok',
      permissions: ['org.view'],
      isBuiltIn: false,
    });
    await expect(assertRolePermissionsInCatalog()).resolves.toBeUndefined();
  });

  it('fails when a role stores an unknown permission', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    await Role.create({
      orgId: org._id,
      name: 'Bad',
      permissions: ['totally.unknown'],
      isBuiltIn: false,
    });
    await expect(assertRolePermissionsInCatalog()).rejects.toThrow(/catalog drift/);
  });
});
