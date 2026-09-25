/**
 * Project members service unit tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import {
  IDENTITY_MODELS,
  createMembership,
  createOrganization,
  createUser, createUserInRepo,
  ensureBuiltInRoles,
  findBuiltInRole,
} from '../../../src/modules/masters/index.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import {
  PROJECT_MEMBER_MODELS,
  addProjectMember,
  removeProjectMember,
} from '../../../src/modules/masters/projectMembers.js';

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...PROJECT_MODELS,
    ...PROJECT_MEMBER_MODELS,
    ...AUDIT_MODELS,
  ],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('projectMembers.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('idempotent add, soft remove, and audits', async () => {
    const org = await createOrganization({ name: 'Svc PM', slug: `svcp-${Date.now()}` });
    await ensureBuiltInRoles(org._id);
    const adminRole = await findBuiltInRole(org._id, 'org_admin');
    const actor = await createUserInRepo(org._id, {
      email: `actor-${Date.now()}@example.com`,
      displayName: 'Actor',
      userStatus: 'active',
    });
    await createMembership(org._id, {
      userId: actor._id,
      roleIds: [adminRole._id],
      projectAccessMode: 'all',
    });
    const target = await createUserInRepo(org._id, {
      email: `target-${Date.now()}@example.com`,
      displayName: 'Target',
      userStatus: 'active',
    });
    await createMembership(org._id, {
      userId: target._id,
      roleIds: [(await findBuiltInRole(org._id, 'member'))._id],
      projectAccessMode: 'selected',
    });
    const project = await createProjectInRepo(org._id, {
      name: 'P',
      sourceType: 'upload',
      createdBy: actor._id,
    });

    const first = await addProjectMember({
      orgId: String(org._id),
      actorUserId: String(actor._id),
      projectId: String(project._id),
      userId: String(target._id),
      permissions: ['projects.view'],
      correlationId: 'c1',
      log: { error: () => {} },
    });
    expect(first.created).toBe(true);

    const second = await addProjectMember({
      orgId: String(org._id),
      actorUserId: String(actor._id),
      projectId: String(project._id),
      userId: String(target._id),
      permissions: ['projects.view'],
      correlationId: 'c2',
      log: { error: () => {} },
    });
    expect(second.created).toBe(false);
    expect(second.member.id).toBe(first.member.id);

    await removeProjectMember({
      orgId: String(org._id),
      actorUserId: String(actor._id),
      projectId: String(project._id),
      userId: String(target._id),
      correlationId: 'c3',
      log: { error: () => {} },
    });

    const reAdd = await addProjectMember({
      orgId: String(org._id),
      actorUserId: String(actor._id),
      projectId: String(project._id),
      userId: String(target._id),
      permissions: ['chat.ask'],
      correlationId: 'c4',
      log: { error: () => {} },
    });
    expect(reAdd.created).toBe(true);
    expect(reAdd.member.id).toBe(first.member.id);

    const added = await listAuditEvents(org._id, { action: 'project.member_added' });
    expect(added.items.length).toBeGreaterThanOrEqual(2);
    const removed = await listAuditEvents(org._id, { action: 'project.member_removed' });
    expect(removed.items.length).toBe(1);
  });
});
