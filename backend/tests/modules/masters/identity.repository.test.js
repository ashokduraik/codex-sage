/**
 * Identity model and repository integration tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROW_STATUS_DELETED } from '../../../src/platform/data/index.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { IDENTITY_MODELS } from '../../../src/modules/masters/index.js';
import { createOrganization } from '../../../src/modules/masters/organizations.js';
import { createUserInRepo, findUserByEmail, findUserById, listUsersInRepo, softDeleteUser } from '../../../src/modules/masters/users.js';
import { ensureBuiltInRoles, softDeleteRoleInRepo, updateRoleInRepo } from '../../../src/modules/masters/roles.js';
import { User } from '../../../src/models/user.model.js';
import mongoose from 'mongoose';
import { Role } from '../../../src/models/role.model.js';
import { Organization } from '../../../src/models/organization.model.js';

const PLACEHOLDER_ROLE_ID = new mongoose.Types.ObjectId();

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('identity models and repositories', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('defaults status to A on insert for org, user, and role', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-a' });
    const { roles } = await ensureBuiltInRoles(org._id);
    const user = await createUserInRepo(org._id, {
      email: 'a@example.com',
      displayName: 'A',
      roleIds: [roles[0]._id],
    });
    expect(org.status).toBe('A');
    expect(user.status).toBe('A');
    expect(roles[0].status).toBe('A');
    expect(user.roleIds).toHaveLength(1);
  });

  it('rejects a userStatus outside active|invited|disabled', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-status' });
    await expect(
      User.create({
        orgId: org._id,
        email: 'x@example.com',
        displayName: 'X',
        userStatus: 'pending',
      }),
    ).rejects.toThrow();
  });

  it('rejects a role whose builtInKey is not one of the four keys', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-rolekey' });
    await expect(
      Role.create({
        orgId: org._id,
        name: 'Bad',
        isBuiltIn: true,
        builtInKey: 'superuser',
        permissions: [],
      }),
    ).rejects.toThrow();
  });

  it('lowercases and trims email before saving', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-email' });
    const user = await createUserInRepo(org._id, {
      email: '  Admin@Example.COM ',
      displayName: 'Admin',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    expect(user.email).toBe('admin@example.com');
  });

  it('omits passwordHash from a default query result', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-hash' });
    const created = await User.create({
      orgId: org._id,
      email: 'hash@example.com',
      displayName: 'Hash',
      passwordHash: 'secret-hash-value',
      userStatus: 'active',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    const found = await findUserByEmail(org._id, 'hash@example.com');
    expect(found?._id.equals(created._id)).toBe(true);
    expect(found?.passwordHash).toBeUndefined();
    const withHash = await User.findById(created._id).select('+passwordHash');
    expect(withHash?.passwordHash).toBe('secret-hash-value');
  });

  it('rejects a rename of a built-in role', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-rename' });
    const { roles } = await ensureBuiltInRoles(org._id);
    await expect(updateRoleInRepo(org._id, roles[0]._id, { name: 'Renamed' })).rejects.toMatchObject({ code: 'BUILT_IN_ROLE_IMMUTABLE' });
  });

  it('rejects a soft delete of a built-in role', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-softdel' });
    const { roles } = await ensureBuiltInRoles(org._id);
    await expect(softDeleteRoleInRepo(org._id, roles[0]._id)).rejects.toMatchObject({
      code: 'BUILT_IN_ROLE_IMMUTABLE',
    });
  });

  it('throws when a repository call is made without an orgId', async () => {
    await expect(listUsersInRepo(/** @type {any} */ (null))).rejects.toMatchObject({
      code: 'TENANT_SCOPE_MISSING',
    });
  });

  it('allows the same email in two different organizations', async () => {
    const first = await createOrganization({ name: 'One', slug: 'org-one' });
    const second = await createOrganization({ name: 'Two', slug: 'org-two' });
    await createUserInRepo(first._id, {
      email: 'shared@example.com',
      displayName: 'S1',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    await createUserInRepo(second._id, {
      email: 'shared@example.com',
      displayName: 'S2',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    expect(await findUserByEmail(first._id, 'shared@example.com')).toBeTruthy();
    expect(await findUserByEmail(second._id, 'shared@example.com')).toBeTruthy();
  });

  it('rejects a duplicate active email inside one organization', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-dup' });
    await createUserInRepo(org._id, {
      email: 'dup@example.com',
      displayName: 'D1',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    await expect(
      createUserInRepo(org._id, {
        email: 'dup@example.com',
        displayName: 'D2',
        roleIds: [PLACEHOLDER_ROLE_ID],
      }),
    ).rejects.toThrow();
  });

  it('allows re-creating a user whose previous row is status D', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-recreate' });
    const user = await createUserInRepo(org._id, {
      email: 'gone@example.com',
      displayName: 'Gone',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    await softDeleteUser(org._id, user._id);
    const again = await createUserInRepo(org._id, {
      email: 'gone@example.com',
      displayName: 'Back',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    expect(again.status).toBe('A');
    expect(again.displayName).toBe('Back');
  });

  it('excludes status D users from listUsers', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-list' });
    const keep = await createUserInRepo(org._id, {
      email: 'keep@example.com',
      displayName: 'Keep',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    const drop = await createUserInRepo(org._id, {
      email: 'drop@example.com',
      displayName: 'Drop',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    await softDeleteUser(org._id, drop._id);
    const listed = await listUsersInRepo(org._id);
    expect(listed.items.map((u) => String(u._id))).toEqual([String(keep._id)]);
  });

  it('returns a keyset page ordered by createdAt/_id descending', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-keyset' });
    const first = await createUserInRepo(org._id, {
      email: 'k1@example.com',
      displayName: 'K1',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    const second = await createUserInRepo(org._id, {
      email: 'k2@example.com',
      displayName: 'K2',
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    const page = await listUsersInRepo(org._id, { limit: 10 });
    expect(page.items.map((u) => String(u._id))).toEqual([String(second._id), String(first._id)]);
    expect(page.pageInfo.hasMore).toBe(false);
  });

  it('finds a user only within its own organization', async () => {
    const orgA = await createOrganization({ name: 'A', slug: 'mem-a' });
    const orgB = await createOrganization({ name: 'B', slug: 'mem-b' });
    const { roles } = await ensureBuiltInRoles(orgA._id);
    const user = await createUserInRepo(orgA._id, {
      email: 'm@example.com',
      displayName: 'M',
      roleIds: [roles[0]._id],
    });
    expect(await findUserById(orgA._id, user._id)).toBeTruthy();
    expect(await findUserById(orgB._id, user._id)).toBeNull();
  });

  it('excludes soft-deleted roles and users from list helpers', async () => {
    const org = await createOrganization({ name: 'Acme', slug: 'acme-lists' });
    const { roles } = await ensureBuiltInRoles(org._id);
    const custom = await Role.create({
      orgId: org._id,
      name: 'Custom',
      isBuiltIn: false,
      permissions: ['projects.view'],
    });
    const user = await createUserInRepo(org._id, {
      email: 'list@example.com',
      displayName: 'L',
      roleIds: [roles[0]._id],
    });
    await softDeleteRoleInRepo(org._id, custom._id);
    await softDeleteUser(org._id, user._id);
    const rolesLeft = await Role.find({ orgId: org._id }).sort({ name: 1 });
    expect(rolesLeft.some((r) => r.name === 'Custom')).toBe(false);
    expect((await listUsersInRepo(org._id)).items).toHaveLength(0);
  });

  it('soft-deletes an organization without removing its _id from history', async () => {
    const org = await createOrganization({ name: 'Gone', slug: 'gone-org' });
    await Organization.updateOne({ _id: org._id }, { $set: { status: 'D' } });
    const found = await Organization.findById(org._id);
    expect(found).toBeNull();
    const deleted = await Organization.findOne({ _id: org._id }).setOptions({
      includeDeleted: true,
    });
    expect(deleted?.status).toBe(ROW_STATUS_DELETED);
  });
});
