/**
 * Unit tests for permission resolution (Mongo).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import {
  IDENTITY_MODELS,
  createOrganization,
  ensureBuiltInRoles,
} from '../../../src/modules/masters/index.js';
import { Role } from '../../../src/models/role.model.js';
import { ALL_PERMISSION_KEYS } from '../../../src/modules/access/permissions.js';
import { createRoleCache } from '../../../src/modules/access/permissions.js';
import { hasRequiredPermissions, resolveEffectivePermissions } from '../../../src/modules/access/permissions.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('permissionResolver', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('unions permissions across roles and de-duplicates', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    const cache = createRoleCache();
    const roleA = await Role.create({
      orgId: org._id,
      name: 'A',
      permissions: ['org.view', 'chat.ask'],
      isBuiltIn: false,
    });
    const roleB = await Role.create({
      orgId: org._id,
      name: 'B',
      permissions: ['chat.ask', 'search.run'],
      isBuiltIn: false,
    });
    const effective = await resolveEffectivePermissions(
      String(org._id),
      [String(roleA._id), String(roleB._id)],
      { cache },
    );
    expect(effective.sort()).toEqual(['chat.ask', 'org.view', 'search.run'].sort());
  });

  it('returns an empty set for missing membership roles and unknown role ids', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    const cache = createRoleCache();
    expect(await resolveEffectivePermissions(String(org._id), [], { cache })).toEqual([]);
    expect(
      await resolveEffectivePermissions(String(org._id), ['507f1f77bcf86cd799439011'], {
        cache,
      }),
    ).toEqual([]);
  });

  it('ignores an unrecognised permission string on a custom role', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    const cache = createRoleCache();
    const role = await Role.create({
      orgId: org._id,
      name: 'Custom',
      permissions: ['org.view', 'not.a.real.permission'],
      isBuiltIn: false,
    });
    const effective = await resolveEffectivePermissions(
      String(org._id),
      [String(role._id)],
      { cache },
    );
    expect(effective).toEqual(['org.view']);
  });

  it('resolves org_admin to every catalog permission from code', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    const { roles } = await ensureBuiltInRoles(org._id);
    const orgAdmin = roles.find((role) => role.builtInKey === 'org_admin');
    const cache = createRoleCache();
    const effective = await resolveEffectivePermissions(
      String(org._id),
      [String(orgAdmin._id)],
      { cache },
    );
    expect(effective.sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
  });

  it('does not resolve roles belonging to another organization', async () => {
    const orgA = await createOrganization({ name: 'A', slug: `a-${Date.now()}` });
    const orgB = await createOrganization({ name: 'B', slug: `b-${Date.now()}` });
    const roleB = await Role.create({
      orgId: orgB._id,
      name: 'Other',
      permissions: ['users.manage'],
      isBuiltIn: false,
    });
    const cache = createRoleCache();
    const effective = await resolveEffectivePermissions(
      String(orgA._id),
      [String(roleB._id)],
      { cache },
    );
    expect(effective).toEqual([]);
  });

  it('uses the cache until invalidateRole', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    const cache = createRoleCache();
    const role = await Role.create({
      orgId: org._id,
      name: 'Custom',
      permissions: ['org.view'],
      isBuiltIn: false,
    });
    const first = await resolveEffectivePermissions(String(org._id), [String(role._id)], {
      cache,
    });
    expect(first).toEqual(['org.view']);
    await Role.updateOne({ _id: role._id }, { $set: { permissions: ['chat.ask'] } });
    const cached = await resolveEffectivePermissions(String(org._id), [String(role._id)], {
      cache,
    });
    expect(cached).toEqual(['org.view']);
    cache.invalidateRole(String(org._id), String(role._id));
    const refreshed = await resolveEffectivePermissions(
      String(org._id),
      [String(role._id)],
      { cache },
    );
    expect(refreshed).toEqual(['chat.ask']);
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
