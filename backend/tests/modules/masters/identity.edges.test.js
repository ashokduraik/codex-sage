/**
 * Additional unit/integration coverage for identity edge branches.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { Role } from '../../../src/models/role.model.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { SLUG_PATTERN } from '../../../src/models/organization.model.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findOrganizationById } from '../../../src/modules/masters/organizations.js';
import { IDENTITY_MODELS, findRoleByCode } from '../../../src/modules/masters/index.js';
import { createTestOrganization, ensureTestRoles, nextTestUserCode } from '../../identityFixtures.js';
import { createUserInRepo, findUserById, softDeleteUser } from '../../../src/modules/masters/users.js';
import { createRoleInRepo, softDeleteRole, softDeleteRoleInRepo, updateRoleInRepo } from '../../../src/modules/masters/roles.js';

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
    const org = await createTestOrganization({ name: 'Find', slug: 'find-me' });
    const found = await findOrganizationById(org._id);
    expect(found?.slug).toBe('find-me');
  });

  it('findUserById returns a user within the org only', async () => {
    const org = await createTestOrganization({ name: 'U', slug: 'user-by-id' });
    const { roles } = await ensureTestRoles(org._id);
    const user = await createUserInRepo(org._id, { code: nextTestUserCode(), email: 'id@example.com', displayName: 'Id', roleIds: [roles[0]._id] });
    expect(await findUserById(org._id, user._id)).toBeTruthy();
    const other = await createTestOrganization({ name: 'O', slug: 'other-org' });
    expect(await findUserById(other._id, user._id)).toBeNull();
  });

  it('updateRole updates custom role fields', async () => {
    const org = await createTestOrganization({ name: 'R', slug: 'role-update' });
    const custom = await Role.create({ code: 'CUSTOM', orgId: org._id, name: 'Custom', permissions: [] });
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
    const org = await createTestOrganization({ name: 'R', slug: 'role-missing' });
    await expect(updateRoleInRepo(org._id, new mongoose.Types.ObjectId(), { name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('softDeleteRole throws NOT_FOUND for a missing role', async () => {
    const org = await createTestOrganization({ name: 'R', slug: 'role-del-missing' });
    const { softDeleteRoleInRepo } = await import('../../../src/modules/masters/roles.js');
    await expect(softDeleteRoleInRepo(org._id, new mongoose.Types.ObjectId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updates ADMIN name and permissions', async () => {
    const org = await createTestOrganization({ name: 'R', slug: 'role-admin-patch' });
    const { admin } = await ensureTestRoles(org._id);
    const updated = await updateRoleInRepo(org._id, admin._id, {
      name: 'Renamed Admin',
      permissions: ['org.view', 'users.manage'],
    });
    expect(updated.name).toBe('Renamed Admin');
    expect(updated.permissions).toEqual(['org.view', 'users.manage']);
    expect(updated.code).toBe('ADMIN');
  });

  it('soft-deletes an unused custom role', async () => {
    const org = await createTestOrganization({ name: 'R', slug: 'role-unused' });
    const custom = await Role.create({
      code: 'CUSTOM',
      orgId: org._id,
      name: 'Custom',
      permissions: ['org.view'],
    });
    const result = await softDeleteRoleInRepo(org._id, custom._id);
    expect(result.modifiedCount).toBe(1);
    expect(await Role.findOne({ _id: custom._id })).toBeNull();
  });

  it('rejects deleting a role still assigned to an active user', async () => {
    const org = await createTestOrganization({ name: 'R', slug: 'role-in-use' });
    const { member } = await ensureTestRoles(org._id);
    await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'held@example.com',
      displayName: 'Held',
      roleIds: [member._id],
    });
    await expect(
      softDeleteRole({
        orgId: String(org._id),
        actorUserId: String(org._id),
        roleId: String(member._id),
        correlationId: 'c-role-in-use',
      }),
    ).rejects.toMatchObject({ code: 'ROLE_IN_USE' });
  });

  it('rejects a duplicate active role code in the same organization', async () => {
    const org = await createTestOrganization({ name: 'R', slug: 'role-dup-code' });
    await createRoleInRepo(org._id, { code: 'ANALYST', name: 'Analyst', permissions: ['org.view'] });
    await expect(createRoleInRepo(org._id, { code: 'ANALYST', name: 'Analyst Two', permissions: ['chat.ask'] })).rejects.toMatchObject({
      code: 'IDENTITY_DUPLICATE_ROLE_CODE',
    });
  });

  it('rejects an invalid role code', async () => {
    const org = await createTestOrganization({ name: 'R', slug: 'role-bad-code' });
    await expect(
      Role.create({
        code: 'not valid',
        orgId: org._id,
        name: 'Nope',
        permissions: [],
      }),
    ).rejects.toThrow();
  });

  it('softDeleteUser succeeds', async () => {
    const org = await createTestOrganization({ name: 'S', slug: 'soft-mem' });
    const { roles } = await ensureTestRoles(org._id);
    const user = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'soft@example.com',
      displayName: 'Soft',
      roleIds: [roles[0]._id],
    });
    expect((await softDeleteUser(org._id, user._id)).modifiedCount).toBe(1);
    expect(await findUserById(org._id, user._id)).toBeNull();
  });

  it('findRoleByCode returns ADMIN after ensureTestRoles', async () => {
    const org = await createTestOrganization({ name: 'B', slug: 'built-in-find' });
    await ensureTestRoles(org._id);
    const role = await findRoleByCode(org._id, 'ADMIN');
    expect(role?.name).toBe('Org Admin');
    expect(role?.code).toBe('ADMIN');
  });

  it('exports the organization slug pattern', () => {
    expect(SLUG_PATTERN.test('default')).toBe(true);
    expect(SLUG_PATTERN.test('Bad!')).toBe(false);
  });

  it('rejects an invalid organization slug', async () => {
    await expect(createTestOrganization({ name: 'Bad', slug: 'Acme Corp!' })).rejects.toThrow();
  });
});
