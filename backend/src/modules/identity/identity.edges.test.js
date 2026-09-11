/**
 * Additional unit/integration coverage for identity edge branches.
 */
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { IDENTITY_MODELS } from './index.js';
import { createOrganization, findOrganizationById } from './organization.repository.js';
import {
  createUser,
  findUserById,
  softDeleteUser,
} from './user.repository.js';
import {
  ensureBuiltInRoles,
  findBuiltInRole,
  updateRole,
} from './role.repository.js';
import {
  createMembership,
  findMembership,
  softDeleteMembership,
} from './membership.repository.js';
import { Role } from './role.model.js';
import { isBuiltInRoleKey } from './builtInRoles.js';
import { SLUG_PATTERN } from './organization.model.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('identity edge coverage', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('findOrganizationById returns the organization', async () => {
    const org = await createOrganization({ name: 'Find', slug: 'find-me' });
    const found = await findOrganizationById(org._id);
    expect(found?.slug).toBe('find-me');
  });

  it('findUserById returns a user within the org only', async () => {
    const org = await createOrganization({ name: 'U', slug: 'user-by-id' });
    const user = await createUser(org._id, {
      email: 'id@example.com',
      displayName: 'Id',
    });
    expect(await findUserById(org._id, user._id)).toBeTruthy();
    const other = await createOrganization({ name: 'O', slug: 'other-org' });
    expect(await findUserById(other._id, user._id)).toBeNull();
  });

  it('updateRole updates custom role fields', async () => {
    const org = await createOrganization({ name: 'R', slug: 'role-update' });
    const custom = await Role.create({
      orgId: org._id,
      name: 'Custom',
      isBuiltIn: false,
      permissions: [],
    });
    const updated = await updateRole(
      org._id,
      custom._id,
      {
        name: 'Custom2',
        permissions: ['chat.ask'],
        description: 'desc',
      },
      { updatedBy: null },
    );
    expect(updated.name).toBe('Custom2');
    expect(updated.permissions).toEqual(['chat.ask']);
    expect(updated.description).toBe('desc');
  });

  it('updateRole throws NOT_FOUND for a missing role', async () => {
    const org = await createOrganization({ name: 'R', slug: 'role-missing' });
    await expect(
      updateRole(org._id, new mongoose.Types.ObjectId(), { name: 'X' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('softDeleteRole throws NOT_FOUND for a missing role', async () => {
    const org = await createOrganization({ name: 'R', slug: 'role-del-missing' });
    const { softDeleteRole } = await import('./role.repository.js');
    await expect(
      softDeleteRole(org._id, new mongoose.Types.ObjectId()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a custom role that carries a builtInKey', async () => {
    const org = await createOrganization({ name: 'R', slug: 'role-custom-key' });
    await expect(
      Role.create({
        orgId: org._id,
        name: 'CustomKey',
        isBuiltIn: false,
        builtInKey: 'org_admin',
        permissions: [],
      }),
    ).rejects.toThrow(/builtInKey is only allowed/);
  });

  it('rejects a custom role marked built-in without a valid key', async () => {
    const org = await createOrganization({ name: 'R', slug: 'role-bad' });
    await expect(
      Role.create({
        orgId: org._id,
        name: 'Nope',
        isBuiltIn: true,
        permissions: [],
      }),
    ).rejects.toThrow();
  });

  it('softDeleteMembership and softDeleteUser succeed', async () => {
    const org = await createOrganization({ name: 'S', slug: 'soft-mem' });
    const { roles } = await ensureBuiltInRoles(org._id);
    const user = await createUser(org._id, {
      email: 'soft@example.com',
      displayName: 'Soft',
    });
    await createMembership(org._id, {
      userId: user._id,
      roleIds: [roles[0]._id],
    });
    expect((await softDeleteMembership(org._id, user._id)).modifiedCount).toBe(1);
    expect(await findMembership(org._id, user._id)).toBeNull();
    expect((await softDeleteUser(org._id, user._id)).modifiedCount).toBe(1);
  });

  it('findBuiltInRole returns org_admin after ensure', async () => {
    const org = await createOrganization({ name: 'B', slug: 'built-in-find' });
    await ensureBuiltInRoles(org._id);
    const role = await findBuiltInRole(org._id, 'org_admin');
    expect(role?.name).toBe('Org Admin');
  });

  it('exports built-in key helper and slug pattern', () => {
    expect(isBuiltInRoleKey('org_admin')).toBe(true);
    expect(isBuiltInRoleKey('nope')).toBe(false);
    expect(SLUG_PATTERN.test('default')).toBe(true);
    expect(SLUG_PATTERN.test('Bad!')).toBe(false);
  });

  it('rejects an invalid organization slug', async () => {
    await expect(
      createOrganization({ name: 'Bad', slug: 'Acme Corp!' }),
    ).rejects.toThrow();
  });
});
