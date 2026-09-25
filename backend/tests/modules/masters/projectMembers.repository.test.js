/**
 * ProjectMember repository tests — reactivation and accessible ids.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { IDENTITY_MODELS, createOrganization } from '../../../src/modules/masters/index.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import {
  PROJECT_MEMBER_MODELS,
  createProjectMember,
  findActiveProjectMember,
  findProjectMemberIncludingDeleted,
  listAccessibleProjectIdsForUser,
  listProjectMembers,
  reactivateProjectMember,
  softDeleteProjectMember,
  clampProjectMembersListLimit,
} from '../../../src/modules/masters/projectMembers.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...PROJECT_MODELS, ...PROJECT_MEMBER_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('projectMembers.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('reactivates soft-deleted members and lists accessible project ids', async () => {
    const org = await createOrganization({ name: 'PM Org', slug: `pm-${Date.now()}` });
    const userId = new mongoose.Types.ObjectId();
    const project = await createProjectInRepo(org._id, {
      name: 'One',
      sourceType: 'upload',
      createdBy: userId,
    });
    const created = await createProjectMember(org._id, {
      projectId: String(project._id),
      userId,
      permissions: ['projects.view'],
      addedByUserId: userId,
    });

    const ids = await listAccessibleProjectIdsForUser(org._id, userId);
    expect(ids).toEqual([String(project._id)]);

    await softDeleteProjectMember(org._id, String(project._id), userId);
    expect(await findActiveProjectMember(org._id, String(project._id), userId)).toBeNull();
    expect(await listAccessibleProjectIdsForUser(org._id, userId)).toEqual([]);

    const deleted = await findProjectMemberIncludingDeleted(
      org._id,
      String(project._id),
      userId,
    );
    expect(deleted).toBeTruthy();
    const reactivated = await reactivateProjectMember(org._id, String(deleted._id), {
      permissions: ['projects.view', 'chat.ask'],
      addedByUserId: userId,
    });
    expect(String(reactivated._id)).toBe(String(created._id));
    expect(reactivated.permissions).toEqual(['projects.view', 'chat.ask']);

    const page = await listProjectMembers(org._id, String(project._id), { limit: 10 });
    expect(page.items).toHaveLength(1);

    await expect(
      listProjectMembers(org._id, String(project._id), { cursor: '!!!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    expect(clampProjectMembersListLimit(undefined)).toBe(20);
    expect(clampProjectMembersListLimit(0)).toBe(20);
    expect(clampProjectMembersListLimit(500)).toBe(100);
  });
});
