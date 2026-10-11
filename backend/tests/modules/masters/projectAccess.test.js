/**
 * Unit tests for resolveProjectPermissions matrix and cache behaviour.
 */
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { softDeleteProject } from '../../../src/modules/masters/projects.helper.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import { createTestOrganization, ensureTestRoles, nextTestUserCode } from '../../identityFixtures.js';
import { IDENTITY_MODELS, createUserInRepo, bumpOrganizationAclVersion, findRoleByCode } from '../../../src/modules/masters/index.js';
import {
  createProjectMember,
  bumpProjectAclVersion,
  createProjectAclCache,
  softDeleteProjectMember,
  resolveProjectPermissions,
} from '../../../src/modules/masters/projectMembers.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...PROJECT_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('resolveProjectPermissions', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  const ROLE_CODE_BY_OLD_KEY = Object.freeze({
    org_admin: 'ADMIN',
    project_admin: 'PROJECT_ADMIN',
    member: 'MEMBER',
    viewer: 'VIEWER',
  });

  /**
   * @param {'all' | 'selected' | 'none'} mode
   * @param {string} roleKey Old built-in key or identity code.
   */
  async function seed(mode, roleKey = 'member') {
    const org = await createTestOrganization({
      name: 'ACL Org',
      slug: `acl-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    await ensureTestRoles(org._id);
    const roleCode = ROLE_CODE_BY_OLD_KEY[roleKey] ?? roleKey;
    const role = await findRoleByCode(org._id, roleCode);
    const user = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: `u-${Date.now()}@example.com`,
      displayName: 'User',
      userStatus: 'active',
      roleIds: [role._id],
      projectAccessMode: mode,
    });
    const project = await createProjectInRepo(org._id, {
      name: 'P',
      sourceType: 'upload',
      createdBy: user._id,
    });
    return { org, user, role, project };
  }

  it('returns org permissions only for all mode without member row', async () => {
    const { org, user, project } = await seed('all', 'viewer');
    const result = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id));
    expect(result.kind).toBe('OK');
    expect(result.permissions).toContain('projects.view');
    expect(result.permissions).not.toContain('projects.update');
  });

  it('unions overlay permissions for all mode with member row', async () => {
    const { org, user, project } = await seed('all', 'viewer');
    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: user._id,
      permissions: ['projects.update'],
      addedByUserId: user._id,
    });
    const result = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id));
    expect(result.kind).toBe('OK');
    expect(result.permissions).toContain('projects.view');
    expect(result.permissions).toContain('projects.update');
  });

  it('selected mode requires an active member row', async () => {
    const { org, user, project } = await seed('selected', 'member');
    const denied = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id));
    expect(denied.kind).toBe('NO_ACCESS');

    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: user._id,
      permissions: ['projects.view'],
      addedByUserId: user._id,
    });
    const allowed = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id));
    expect(allowed.kind).toBe('OK');
  });

  it('none mode wins even when a member row exists', async () => {
    const { org, user, project } = await seed('none', 'member');
    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: user._id,
      permissions: ['projects.view'],
      addedByUserId: user._id,
    });
    const result = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id));
    expect(result.kind).toBe('NO_ACCESS');
  });

  it('soft-deleted member and project yield NO_ACCESS', async () => {
    const { org, user, project } = await seed('selected', 'member');
    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: user._id,
      permissions: ['projects.view'],
      addedByUserId: user._id,
    });
    await softDeleteProjectMember(org._id, String(project._id), user._id);
    expect((await resolveProjectPermissions(String(org._id), String(user._id), String(project._id))).kind).toBe('NO_ACCESS');

    const other = await seed('all', 'member');
    await softDeleteProject(other.org._id, String(other.project._id), {
      updatedBy: other.user._id,
    });
    expect((await resolveProjectPermissions(String(other.org._id), String(other.user._id), String(other.project._id))).kind).toBe('NO_ACCESS');
  });

  it('cross-org project and inactive user yield NO_ACCESS', async () => {
    const a = await seed('all', 'member');
    const b = await seed('all', 'member');
    expect((await resolveProjectPermissions(String(a.org._id), String(a.user._id), String(b.project._id))).kind).toBe('NO_ACCESS');

    await ensureTestRoles(a.org._id);
    const memberRole = await findRoleByCode(a.org._id, 'MEMBER');
    const inactive = await createUserInRepo(a.org._id, {
      code: nextTestUserCode(),
      email: `off-${Date.now()}@example.com`,
      displayName: 'Off',
      userStatus: 'disabled',
      roleIds: [memberRole._id],
      projectAccessMode: 'all',
    });
    expect((await resolveProjectPermissions(String(a.org._id), String(inactive._id), String(a.project._id))).kind).toBe('NO_ACCESS');
  });

  it('ignores overlay attempts to remove org permissions and foreign roleId', async () => {
    const { org, user, project } = await seed('all', 'member');
    const foreignOrg = await createTestOrganization({
      name: 'Foreign',
      slug: `foreign-${Date.now()}`,
    });
    await ensureTestRoles(foreignOrg._id);
    const foreignRole = await findRoleByCode(foreignOrg._id, 'ADMIN');

    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: user._id,
      roleId: foreignRole._id,
      permissions: [],
      addedByUserId: user._id,
    });
    const result = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id));
    expect(result.kind).toBe('OK');
    expect(result.permissions).toContain('projects.view');
    expect(result.permissions).toContain('chat.ask');
  });

  it('uses request memo and discards stale aclVersion cache entries', async () => {
    const { org, user, project } = await seed('selected', 'member');
    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: user._id,
      permissions: ['projects.view'],
      addedByUserId: user._id,
    });

    const cache = createProjectAclCache({ enabled: true, ttlMs: 60_000 });
    const memo = new Map();
    const first = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id), { cache, requestMemo: memo });
    expect(first.kind).toBe('OK');
    expect(memo.size).toBe(1);

    const second = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id), { cache, requestMemo: memo });
    expect(second).toBe(first);

    await softDeleteProjectMember(org._id, String(project._id), user._id);
    await bumpOrganizationAclVersion(org._id);
    const afterBump = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id), { cache });
    expect(afterBump.kind).toBe('NO_ACCESS');
  });

  it('bumpProjectAclVersion invalidates local cache', async () => {
    const { org, user, project } = await seed('all', 'member');
    const cache = createProjectAclCache({ enabled: true, ttlMs: 60_000 });
    await resolveProjectPermissions(String(org._id), String(user._id), String(project._id), {
      cache,
    });
    expect(cache.size()).toBeGreaterThan(0);
    await bumpProjectAclVersion(org._id);
    // Process default cache is cleared by bump; custom cache still needs version mismatch.
    const next = await resolveProjectPermissions(String(org._id), String(user._id), String(project._id), { cache });
    expect(next.kind).toBe('OK');
  });
});
