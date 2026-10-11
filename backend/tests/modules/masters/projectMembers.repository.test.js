/**
 * Project member overlay repository tests — reactivation and accessible ids.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { createTestOrganization } from '../../identityFixtures.js';
import { IDENTITY_MODELS } from '../../../src/modules/masters/index.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dropProjectMembersCollectionIfPresent } from '../../../src/platform/data/index.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import {
  listProjectMembers,
  createProjectMember,
  findActiveProjectMember,
  reactivateProjectMember,
  softDeleteProjectMember,
  findActiveMemberOnProject,
  listAccessibleProjectIdsForUser,
  findProjectMemberIncludingDeleted,
} from '../../../src/modules/masters/projectMembers.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...PROJECT_MODELS],
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
    const org = await createTestOrganization({ name: 'PM Org', slug: `pm-${Date.now()}` });
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

    const deleted = await findProjectMemberIncludingDeleted(org._id, String(project._id), userId);
    expect(deleted).toBeTruthy();
    const reactivated = await reactivateProjectMember(org._id, String(deleted._id), {
      permissions: ['projects.view', 'chat.ask'],
      addedByUserId: userId,
    });
    expect(String(reactivated._id)).toBe(String(created._id));
    expect(reactivated.permissions).toEqual(['projects.view', 'chat.ask']);

    const items = await listProjectMembers(org._id, String(project._id));
    expect(items).toHaveLength(1);
  });

  it('does not clobber lifecycleStatus or counts when pushing a member', async () => {
    const org = await createTestOrganization({ name: 'PM Iso', slug: `pm-iso-${Date.now()}` });
    const actorId = new mongoose.Types.ObjectId();
    const project = await createProjectInRepo(org._id, {
      name: 'Isolated',
      sourceType: 'upload',
      createdBy: actorId,
    });
    await project.updateOne({
      $set: {
        lifecycleStatus: 'processing',
        counts: { sourceVersions: 3, files: 12, excludedFiles: 1, conversations: 4 },
      },
    });

    const memberUserId = new mongoose.Types.ObjectId();
    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: memberUserId,
      permissions: ['projects.view'],
      addedByUserId: actorId,
    });

    const reloaded = await mongoose.connection.db.collection('projects').findOne({ _id: project._id });
    expect(reloaded.lifecycleStatus).toBe('processing');
    expect(reloaded.counts).toMatchObject({
      sourceVersions: 3,
      files: 12,
      excludedFiles: 1,
      conversations: 4,
    });
    expect(reloaded.members).toHaveLength(1);
    expect(String(reloaded.members[0].userId)).toBe(String(memberUserId));
  });

  it('covers invalid ids, missing project, duplicate push, and list sort', async () => {
    const org = await createTestOrganization({ name: 'PM Edges', slug: `pm-e-${Date.now()}` });
    const actorId = new mongoose.Types.ObjectId();
    const firstUser = new mongoose.Types.ObjectId();
    const secondUser = new mongoose.Types.ObjectId();
    const project = await createProjectInRepo(org._id, {
      name: 'Edges',
      sourceType: 'upload',
      createdBy: actorId,
    });

    expect(findActiveMemberOnProject(null, firstUser)).toBeNull();
    expect(findActiveMemberOnProject({ members: 'nope' }, firstUser)).toBeNull();
    expect(await findActiveProjectMember(org._id, 'not-an-id', firstUser)).toBeNull();
    expect(await findProjectMemberIncludingDeleted(org._id, 'not-an-id', firstUser)).toBeNull();
    expect(await findProjectMemberIncludingDeleted(org._id, String(project._id), 'bad')).toBeNull();
    expect(await findProjectMemberIncludingDeleted(org._id, new mongoose.Types.ObjectId().toHexString(), firstUser)).toBeNull();
    expect(await listAccessibleProjectIdsForUser(org._id, 'bad')).toEqual([]);
    expect(await listProjectMembers(org._id, 'bad')).toEqual([]);
    expect(await listProjectMembers(org._id, new mongoose.Types.ObjectId().toHexString())).toEqual([]);
    expect(
      await createProjectMember(org._id, {
        projectId: 'bad',
        userId: firstUser,
        addedByUserId: actorId,
      }),
    ).toBeNull();
    expect(await reactivateProjectMember(org._id, 'bad', { addedByUserId: actorId })).toBeNull();
    expect(
      await reactivateProjectMember(org._id, new mongoose.Types.ObjectId().toHexString(), {
        addedByUserId: actorId,
      }),
    ).toBeNull();
    expect((await softDeleteProjectMember(org._id, 'bad', firstUser)).matchedCount).toBe(0);

    const first = await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: firstUser,
      permissions: ['projects.view'],
      addedByUserId: actorId,
    });
    expect(
      await createProjectMember(org._id, {
        projectId: String(project._id),
        userId: firstUser,
        permissions: ['chat.ask'],
        addedByUserId: actorId,
      }),
    ).toBeNull();
    expect(String((await findProjectMemberIncludingDeleted(org._id, String(project._id), firstUser))._id)).toBe(String(first._id));

    await createProjectMember(org._id, {
      projectId: String(project._id),
      userId: secondUser,
      permissions: ['chat.ask'],
      addedByUserId: actorId,
    });
    const listed = await listProjectMembers(org._id, String(project._id));
    expect(listed).toHaveLength(2);
    expect(listed[0].createdAt.getTime()).toBeGreaterThanOrEqual(listed[1].createdAt.getTime());

    await expect(listProjectMembers(undefined, String(project._id))).rejects.toMatchObject({
      code: 'TENANT_SCOPE_MISSING',
    });
  });

  it('picks the newest deleted grant when several tombstones exist', async () => {
    const org = await createTestOrganization({ name: 'PM Tomb', slug: `pm-t-${Date.now()}` });
    const userId = new mongoose.Types.ObjectId();
    const olderId = new mongoose.Types.ObjectId();
    const newerId = new mongoose.Types.ObjectId();
    const project = await createProjectInRepo(org._id, {
      name: 'Tombstones',
      sourceType: 'upload',
      createdBy: userId,
      members: [
        {
          _id: olderId,
          userId,
          roleId: null,
          permissions: [],
          addedByUserId: userId,
          status: 'D',
          createdBy: userId,
          updatedBy: userId,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          _id: newerId,
          userId,
          roleId: null,
          permissions: ['projects.view'],
          addedByUserId: userId,
          status: 'D',
          createdBy: userId,
          updatedBy: userId,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
    });

    const deleted = await findProjectMemberIncludingDeleted(org._id, String(project._id), userId);
    expect(String(deleted._id)).toBe(String(newerId));
  });

  it('forwards an optional Mongo session on member writes and reads', async () => {
    const org = await createTestOrganization({ name: 'PM Sess', slug: `pm-s-${Date.now()}` });
    const userId = new mongoose.Types.ObjectId();
    const project = await createProjectInRepo(org._id, {
      name: 'Sessioned',
      sourceType: 'upload',
      createdBy: userId,
    });
    const session = await mongoose.startSession();
    try {
      const created = await createProjectMember(
        org._id,
        {
          projectId: String(project._id),
          userId,
          permissions: ['projects.view'],
          addedByUserId: userId,
        },
        { session },
      );
      expect(created).toBeTruthy();
      expect(await findActiveProjectMember(org._id, String(project._id), userId, { session })).toBeTruthy();
      expect(await listAccessibleProjectIdsForUser(org._id, userId, { session })).toEqual([String(project._id)]);
      await softDeleteProjectMember(org._id, String(project._id), userId, {
        updatedBy: userId,
        session,
      });
      const deleted = await findProjectMemberIncludingDeleted(org._id, String(project._id), userId, { session });
      expect(deleted.status).toBe('D');
      const reactivated = await reactivateProjectMember(
        org._id,
        String(deleted._id),
        { permissions: ['chat.ask'], addedByUserId: userId },
        { session },
      );
      expect(reactivated.status).toBe('A');
    } finally {
      await session.endSession();
    }
  });

  it('drops a leftover project_members collection when present', async () => {
    const db = mongoose.connection.db;
    const existing = await db.listCollections({ name: 'project_members' }).toArray();
    if (existing.length === 0) {
      await db.createCollection('project_members');
    }
    await dropProjectMembersCollectionIfPresent();
    expect(await db.listCollections({ name: 'project_members' }).toArray()).toEqual([]);
    await dropProjectMembersCollectionIfPresent();
  });
});
