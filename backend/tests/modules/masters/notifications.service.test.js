/**
 * Notification fan-out, list, and mark-read service tests.
 */
import { createTestOrganization, ensureTestRoles, nextTestUserCode } from '../../identityFixtures.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { Notification } from '../../../src/models/notification.model.js';
import { IDENTITY_MODELS, createUserInRepo, findRoleByCode } from '../../../src/modules/masters/index.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import {
  emitNotificationsForJobTerminal,
  emitProjectNotification,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  permissionForNotificationType,
} from '../../../src/modules/masters/notifications.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...PROJECT_MODELS, Notification],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {Promise<{ orgId: string, userId: string, projectId: string }>}
 */
async function seedNotifyProject() {
  const org = await createTestOrganization({
    name: 'Notify Org',
    slug: `notify-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  });
  await ensureTestRoles(org._id);
  const role = await findRoleByCode(org._id, 'PROJECT_ADMIN');
  const user = await createUserInRepo(org._id, {
    code: nextTestUserCode(),
    email: `n-${Date.now()}@example.com`,
    displayName: 'Notifier',
    userStatus: 'active',
    roleIds: [role._id],
    projectAccessMode: 'all',
  });
  const project = await createProjectInRepo(org._id, {
    name: 'Notify fixture',
    sourceType: 'upload',
    createdBy: user._id,
  });
  return {
    orgId: String(org._id),
    userId: String(user._id),
    projectId: String(project._id),
  };
}

describe('notifications.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('maps notification types to recipient permissions', () => {
    expect(permissionForNotificationType('processing.attention')).toBe('knowledge.trigger');
    expect(permissionForNotificationType('repo.sync.completed')).toBe('projects.view');
    expect(permissionForNotificationType('repo.sync.failed')).toBe('projects.view');
    expect(permissionForNotificationType('knowledge.completed')).toBe('knowledge.view');
  });

  it('emits knowledge.completed to members with knowledge.view and dedupes', async () => {
    const { orgId, userId, projectId } = await seedNotifyProject();
    const jobId = new mongoose.Types.ObjectId().toHexString();
    const first = await emitProjectNotification({
      orgId,
      projectId,
      type: 'knowledge.completed',
      jobId,
      sourceVersionId: new mongoose.Types.ObjectId().toHexString(),
    });
    const second = await emitProjectNotification({
      orgId,
      projectId,
      type: 'knowledge.completed',
      jobId,
    });
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBeGreaterThanOrEqual(1);
    expect(await Notification.countDocuments({ orgId, userId })).toBe(1);
  });

  it('skips unknown types and emit failures without throwing', async () => {
    const log = { error: vi.fn() };
    await expect(
      emitProjectNotification({
        orgId: new mongoose.Types.ObjectId().toHexString(),
        projectId: new mongoose.Types.ObjectId().toHexString(),
        type: 'approval.requested',
        log,
      }),
    ).resolves.toBe(0);
    expect(log.error).toHaveBeenCalled();

    await expect(
      emitProjectNotification({
        orgId: new mongoose.Types.ObjectId().toHexString(),
        projectId: new mongoose.Types.ObjectId().toHexString(),
        type: 'knowledge.failed',
        log,
      }),
    ).resolves.toBe(0);
  });

  it('emits attention only for user_action_required and knowledge.completed on warning success', async () => {
    const { orgId, userId, projectId } = await seedNotifyProject();
    const jobId = new mongoose.Types.ObjectId();

    await emitNotificationsForJobTerminal({
      job: {
        _id: jobId,
        orgId,
        projectId,
        jobType: 'ingest',
        createdBy: userId,
      },
      result: 'completed_with_warnings',
    });
    const types = (await Notification.find({ orgId, userId }).lean()).map((row) => row.type);
    expect(types).toEqual(['knowledge.completed']);

    await emitNotificationsForJobTerminal({
      job: {
        _id: new mongoose.Types.ObjectId(),
        orgId,
        projectId,
        jobType: 'ingest',
        createdBy: userId,
      },
      result: 'failed',
      failureClass: 'user_action_required',
    });
    const afterFail = (await Notification.find({ orgId, userId }).lean()).map((row) => row.type).sort();
    expect(afterFail).toEqual(['knowledge.completed', 'knowledge.failed', 'processing.attention']);
  });

  it('emits repo.sync.completed for a successful repo_sync job', async () => {
    const { orgId, userId, projectId } = await seedNotifyProject();
    await emitNotificationsForJobTerminal({
      job: {
        _id: new mongoose.Types.ObjectId(),
        orgId,
        projectId,
        jobType: 'repo_sync',
        createdBy: userId,
      },
      result: 'completed',
    });
    const rows = await Notification.find({ orgId, userId }).lean();
    expect(rows.map((row) => row.type)).toEqual(['repo.sync.completed']);
  });

  it('skips jobs without a project id', async () => {
    await emitNotificationsForJobTerminal({
      job: { orgId: new mongoose.Types.ObjectId().toHexString(), jobType: 'retention' },
      result: 'completed',
    });
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('lists, marks one, and marks all read', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const userId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId();
    await Notification.create([
      {
        orgId,
        userId,
        type: 'knowledge.completed',
        title: 'One',
        body: 'First',
        resourceRef: { projectId },
        readAt: null,
        dedupeKey: 'a:knowledge.completed',
        createdBy: null,
        updatedBy: null,
      },
      {
        orgId,
        userId,
        type: 'knowledge.failed',
        title: 'Two',
        body: 'Second',
        resourceRef: { projectId },
        readAt: null,
        dedupeKey: 'b:knowledge.failed',
        createdBy: null,
        updatedBy: null,
      },
    ]);

    const listed = await listNotificationsForUser(orgId, userId, { limit: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.unreadTotal).toBe(2);
    expect(listed.nextCursor).toBeTruthy();

    const marked = await markNotificationRead(orgId, userId, listed.items[0].id);
    expect(marked.readAt).toBeTruthy();

    const unreadOnly = await listNotificationsForUser(orgId, userId, { unread: true });
    expect(unreadOnly.items).toHaveLength(1);
    expect(unreadOnly.unreadTotal).toBe(1);

    const all = await markAllNotificationsRead(orgId, userId);
    expect(all.updatedCount).toBe(1);
    const after = await listNotificationsForUser(orgId, userId);
    expect(after.unreadTotal).toBe(0);
  });

  it('rejects a malformed cursor and a missing notification id', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const userId = new mongoose.Types.ObjectId().toHexString();
    await expect(listNotificationsForUser(orgId, userId, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(markNotificationRead(orgId, userId, 'bad')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(markNotificationRead(orgId, userId, new mongoose.Types.ObjectId().toHexString())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
