/**
 * Project service unit tests (Mongo harness).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import {
  IDENTITY_MODELS,
  createMembership,
  createOrganization,
  createUser, createUserInRepo,
  findBuiltInRole,
  ensureBuiltInRoles,
} from '../../../src/modules/masters/index.js';
import { PROJECT_MEMBER_MODELS } from '../../../src/modules/masters/projectMembers.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  getDeletionPreview,
  getProject,
  getProjectSettings,
  listProjects,
  patchProjectSettings,
  recordProjectAccess,
  restoreProject,
  transitionLifecycle,
  updateProject,
} from '../../../src/modules/masters/projects.js';
import { Project } from '../../../src/models/projects.model.js';
import { findProjectById } from '../../../src/modules/masters/projects.helper.js';

const harness = createMongoHarness({
  models: [Project, ...AUDIT_MODELS, ...IDENTITY_MODELS, ...PROJECT_MEMBER_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ error: Function }}
 */
function mockLog() {
  return { error: () => {} };
}

/**
 * Seeds an org admin-like actor with projectAccessMode all.
 * @returns {Promise<{ orgId: mongoose.Types.ObjectId, actor: mongoose.Types.ObjectId }>}
 */
async function seedActorWithAllProjects() {
  const org = await createOrganization({ name: 'Svc Org', slug: `svc-${Date.now()}` });
  await ensureBuiltInRoles(org._id);
  const orgAdmin = await findBuiltInRole(org._id, 'org_admin');
  const actor = await createUserInRepo(org._id, {
    email: `actor-${Date.now()}@example.com`,
    displayName: 'Actor',
    userStatus: 'active',
  });
  await createMembership(org._id, {
    userId: actor._id,
    roleIds: [orgAdmin._id],
    projectAccessMode: 'all',
  });
  return { orgId: org._id, actor: actor._id };
}

describe('projects.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('creates upload and repository projects with audit', async () => {
    const { orgId, actor } = await seedActorWithAllProjects();

    const upload = await createProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      name: 'Upload Proj',
      sourceType: 'upload',
      correlationId: 'corr-create-upload',
      log: mockLog(),
    });
    expect(upload.lifecycleStatus).toBe('awaiting_source');
    expect(upload.knowledgeHealth).toBe('none');

    const repo = await createProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      name: 'Repo Proj',
      sourceType: 'repository',
      correlationId: 'corr-create-repo',
      log: mockLog(),
    });
    expect(repo.lifecycleStatus).toBe('connecting_repository');

    const audits = await listAuditEvents(orgId, { action: 'project.create' });
    expect(audits.items.length).toBe(2);
  });

  it('archives, restores, and soft-deletes with audit', async () => {
    const { orgId, actor } = await seedActorWithAllProjects();
    const created = await createProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      name: 'Lifecycle',
      sourceType: 'upload',
      correlationId: 'corr-life',
      log: mockLog(),
    });

    const archived = await archiveProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      projectId: created.id,
      correlationId: 'corr-arch',
      log: mockLog(),
    });
    expect(archived.lifecycleStatus).toBe('archived');
    expect(archived.archivedAt).toBeTruthy();

    await expect(
      archiveProject({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: created.id,
        correlationId: 'corr-arch2',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    const restored = await restoreProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      projectId: created.id,
      correlationId: 'corr-rest',
      log: mockLog(),
    });
    expect(restored.lifecycleStatus).toBe('awaiting_source');
    expect(restored.archivedAt).toBeNull();

    const preview = await getDeletionPreview(String(orgId), created.id);
    expect(preview.counts.jobs).toBe(0);
    expect(preview.consequences).toHaveLength(5);

    await deleteProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      projectId: created.id,
      correlationId: 'corr-del',
      log: mockLog(),
    });
    expect(await findProjectById(orgId, created.id)).toBeNull();
    await expect(getProject(String(orgId), created.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const deleteAudits = await listAuditEvents(orgId, { action: 'project.delete' });
    expect(deleteAudits.items.length).toBe(1);
  });

  it('updates metadata and rejects unknown settings', async () => {
    const { orgId, actor } = await seedActorWithAllProjects();
    const created = await createProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      name: 'Meta',
      description: 'old',
      sourceType: 'upload',
      correlationId: 'corr-meta',
      log: mockLog(),
    });

    const updated = await updateProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      projectId: created.id,
      name: 'Meta 2',
      description: 'new',
      correlationId: 'corr-upd',
      log: mockLog(),
    });
    expect(updated.name).toBe('Meta 2');
    expect(updated.description).toBe('new');

    await expect(
      patchProjectSettings({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: created.id,
        settings: { unknown: true },
        correlationId: 'corr-set',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });

    const accessed = await recordProjectAccess(String(orgId), created.id);
    expect(accessed.lastAccessedAt).toBeTruthy();
    await expect(
      recordProjectAccess(String(orgId), new mongoose.Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects worker-only transitions from api and loses races once', async () => {
    const { orgId, actor } = await seedActorWithAllProjects();
    const created = await createProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      name: 'Race',
      sourceType: 'upload',
      correlationId: 'corr-race',
      log: mockLog(),
    });

    await expect(
      transitionLifecycle({
        orgId: String(orgId),
        projectId: created.id,
        from: 'awaiting_source',
        to: 'knowledge_ready',
        source: 'api',
        knowledgeVersionId: new mongoose.Types.ObjectId().toHexString(),
        actorUserId: String(actor),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    // Stale `from` that no longer matches: re-read then reject the attempted pair.
    await expect(
      transitionLifecycle({
        orgId: String(orgId),
        projectId: created.id,
        from: 'creating',
        to: 'awaiting_source',
        source: 'api',
        actorUserId: String(actor),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('covers get/list/settings and not-found paths', async () => {
    const { orgId, actor } = await seedActorWithAllProjects();
    const missing = new mongoose.Types.ObjectId().toHexString();

    await expect(getProject(String(orgId), missing)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      updateProject({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: missing,
        name: 'x',
        correlationId: 'c',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      archiveProject({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: missing,
        correlationId: 'c',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      restoreProject({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: missing,
        correlationId: 'c',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getDeletionPreview(String(orgId), missing)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      deleteProject({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: missing,
        correlationId: 'c',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      patchProjectSettings({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: missing,
        settings: {},
        correlationId: 'c',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const created = await createProject({
      orgId: String(orgId),
      actorUserId: String(actor),
      name: 'Listed',
      sourceType: 'upload',
      correlationId: 'corr-list',
      log: mockLog(),
    });

    const listed = await listProjects(String(orgId), String(actor), { q: 'Listed', limit: 10 });
    expect(listed.items.some((row) => row.id === created.id)).toBe(true);

    const settings = await getProjectSettings(String(orgId), created.id);
    expect(settings).toEqual({ settings: {} });

    const patched = await patchProjectSettings({
      orgId: String(orgId),
      actorUserId: String(actor),
      projectId: created.id,
      settings: {},
      correlationId: 'corr-set-ok',
      log: mockLog(),
    });
    expect(patched.settings).toEqual({});

    await expect(
      restoreProject({
        orgId: String(orgId),
        actorUserId: String(actor),
        projectId: created.id,
        correlationId: 'corr-rest-bad',
        log: mockLog(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    await expect(
      transitionLifecycle({
        orgId: String(orgId),
        projectId: missing,
        from: 'awaiting_source',
        to: 'failed',
        source: 'api',
        actorUserId: String(actor),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
