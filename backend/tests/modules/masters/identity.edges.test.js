/**
 * Additional unit/integration coverage for identity edge branches.
 */
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { IDENTITY_MODELS } from '../../../src/modules/masters/index.js';
import { createOrganization, findOrganizationById } from '../../../src/modules/masters/organizations.js';
import { createUserInRepo, findUserById, softDeleteUser } from '../../../src/modules/masters/users.js';
import { ensureBuiltInRoles, findBuiltInRole, updateRoleInRepo } from '../../../src/modules/masters/roles.js';
import { isBuiltInRoleKey, Role } from '../../../src/models/role.model.js';
import { SLUG_PATTERN } from '../../../src/models/organization.model.js';

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
    const { roles } = await ensureBuiltInRoles(org._id);
    const user = await createUserInRepo(org._id, {
      email: 'id@example.com',
      displayName: 'Id',
      roleIds: [roles[0]._id],
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
    const updated = await updateRoleInRepo(
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
    await expect(updateRoleInRepo(org._id, new mongoose.Types.ObjectId(), { name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('softDeleteRole throws NOT_FOUND for a missing role', async () => {
    const org = await createOrganization({ name: 'R', slug: 'role-del-missing' });
    const { softDeleteRoleInRepo } = await import('../../../src/modules/masters/roles.js');
    await expect(softDeleteRoleInRepo(org._id, new mongoose.Types.ObjectId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
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

  it('softDeleteUser succeeds', async () => {
    const org = await createOrganization({ name: 'S', slug: 'soft-mem' });
    const { roles } = await ensureBuiltInRoles(org._id);
    const user = await createUserInRepo(org._id, {
      email: 'soft@example.com',
      displayName: 'Soft',
      roleIds: [roles[0]._id],
    });
    expect((await softDeleteUser(org._id, user._id)).modifiedCount).toBe(1);
    expect(await findUserById(org._id, user._id)).toBeNull();
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
    await expect(createOrganization({ name: 'Bad', slug: 'Acme Corp!' })).rejects.toThrow();
  });
});
