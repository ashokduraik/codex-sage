/**
 * Project repository — scoping, pagination, soft delete, duplicate names allowed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { encodeCursor } from '../../../src/platform/data/index.js';
import {
  clampProjectsListLimit,
  conditionalLifecycleUpdate,
  createProject,
  findProjectById,
  listProjects,
  softDeleteProject,
  updateProjectMetadata,
  updateProjectSettings,
  updateProjectSourceConfig,
  touchProjectLastAccessedAt,
  resolveProjectsListSort,
  adjustProjectConversationCount,
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_LIMIT,
} from '../../../src/modules/masters/projects.helper.js';
import { Project } from '../../../src/models/projects.model.js';

const harness = createMongoHarness({
  models: [Project],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('projects.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('clamps list limits and resolves sort', () => {
    expect(clampProjectsListLimit(undefined)).toBe(PROJECTS_LIST_DEFAULT_LIMIT);
    expect(clampProjectsListLimit(0)).toBe(PROJECTS_LIST_DEFAULT_LIMIT);
    expect(clampProjectsListLimit(999)).toBe(PROJECTS_LIST_MAX_LIMIT);
    expect(clampProjectsListLimit(7)).toBe(7);
    expect(resolveProjectsListSort(undefined)).toBe('updatedAt');
    expect(resolveProjectsListSort('lastAccessedAt')).toBe('lastAccessedAt');
    expect(resolveProjectsListSort('nope')).toBe('updatedAt');
  });

  it('scopes finds by orgId and allows duplicate names', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();

    const a1 = await createProject(orgA, {
      name: 'Atlas',
      sourceType: 'upload',
      createdBy: actor,
    });
    const a2 = await createProject(orgA, {
      name: 'Atlas',
      sourceType: 'repository',
      createdBy: actor,
    });
    const b1 = await createProject(orgB, {
      name: 'Atlas',
      sourceType: 'upload',
      createdBy: actor,
    });

    expect(String(a1._id)).not.toBe(String(a2._id));
    expect(await findProjectById(orgA, String(b1._id))).toBeNull();
    expect(await findProjectById(orgA, String(a1._id))).not.toBeNull();
  });

  it('paginates by updatedAt keyset and excludes archived by default', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await createProject(orgId, {
        name: `P${i}`,
        sourceType: 'upload',
        createdBy: actor,
      });
      row.lifecycleStatus = 'awaiting_source';
      row.updatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      await row.save();
      created.push(row);
    }

    const archived = created[0];
    await conditionalLifecycleUpdate(orgId, String(archived._id), {
      from: 'awaiting_source',
      to: 'archived',
      preArchiveLifecycleStatus: 'awaiting_source',
      archivedAt: new Date(),
    });

    const page1 = await listProjects(orgId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.pageInfo.hasMore).toBe(true);
    expect(page1.pageInfo.nextCursor).toBeTruthy();
    expect(page1.items.every((row) => row.lifecycleStatus !== 'archived')).toBe(true);

    const page2 = await listProjects(orgId, {
      limit: 2,
      cursor: page1.pageInfo.nextCursor,
    });
    expect(page2.items).toHaveLength(2);

    const withArchived = await listProjects(orgId, { includeArchived: true, limit: 10 });
    expect(withArchived.items.some((row) => row.lifecycleStatus === 'archived')).toBe(true);
  });

  it('rejects a malformed cursor', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await expect(listProjects(orgId, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    const badTs = encodeCursor({
      t: 'not-a-date',
      i: new mongoose.Types.ObjectId().toHexString(),
    });
    await expect(listProjects(orgId, { cursor: badTs })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const badId = encodeCursor({
      t: '2026-01-01T00:00:00.000Z',
      i: 'nope',
    });
    await expect(listProjects(orgId, { cursor: badId })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('soft-deletes and hides the row from default finds', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const project = await createProject(orgId, {
      name: 'Gone',
      sourceType: 'upload',
      createdBy: actor,
    });
    const result = await softDeleteProject(orgId, String(project._id), {
      updatedBy: String(actor),
    });
    expect(result.matchedCount).toBe(1);
    expect(await findProjectById(orgId, String(project._id))).toBeNull();
  });

  it('returns null for invalid project ids', async () => {
    const orgId = new mongoose.Types.ObjectId();
    expect(await findProjectById(orgId, 'nope')).toBeNull();
  });

  it('covers invalid id branches and name-only metadata updates', async () => {
    const orgId = new mongoose.Types.ObjectId();
    expect(await updateProjectMetadata(orgId, 'bad', { name: 'x' })).toBeNull();
    expect(await updateProjectSettings(orgId, 'bad', { settings: {} })).toBeNull();
    expect(await touchProjectLastAccessedAt(orgId, 'bad')).toBeNull();
    expect(
      await conditionalLifecycleUpdate(orgId, 'bad', {
        from: 'creating',
        to: 'failed',
      }),
    ).toBeNull();
    const soft = await softDeleteProject(orgId, 'bad');
    expect(soft.matchedCount).toBe(0);

    const actor = new mongoose.Types.ObjectId();
    const project = await createProject(orgId, {
      name: 'MetaOnly',
      sourceType: 'upload',
      createdBy: actor,
    });
    const named = await updateProjectMetadata(orgId, String(project._id), {
      name: 'MetaOnly2',
      updatedBy: String(actor),
    });
    expect(named?.name).toBe('MetaOnly2');
    const described = await updateProjectMetadata(orgId, String(project._id), {
      description: 'only desc',
      updatedBy: String(actor),
    });
    expect(described?.description).toBe('only desc');
  });

  it('touches lastAccessedAt and sorts by it with nulls last', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const untouched = await createProject(orgId, {
      name: 'Untouched',
      sourceType: 'upload',
      createdBy: actor,
    });
    untouched.lifecycleStatus = 'awaiting_source';
    await untouched.save();

    const older = await createProject(orgId, {
      name: 'OlderAccess',
      sourceType: 'upload',
      createdBy: actor,
    });
    older.lifecycleStatus = 'awaiting_source';
    older.lastAccessedAt = new Date('2026-01-01T00:00:00.000Z');
    await older.save();

    const newer = await createProject(orgId, {
      name: 'NewerAccess',
      sourceType: 'upload',
      createdBy: actor,
    });
    newer.lifecycleStatus = 'awaiting_source';
    await newer.save();

    const touched = await touchProjectLastAccessedAt(orgId, String(newer._id));
    expect(touched?.lastAccessedAt).toBeInstanceOf(Date);

    const page1 = await listProjects(orgId, { sort: 'lastAccessedAt', limit: 2 });
    expect(page1.items.map((row) => row.name)).toEqual(['NewerAccess', 'OlderAccess']);
    expect(page1.pageInfo.hasMore).toBe(true);

    const page2 = await listProjects(orgId, {
      sort: 'lastAccessedAt',
      limit: 2,
      cursor: page1.pageInfo.nextCursor,
    });
    expect(page2.items.map((row) => row.name)).toEqual(['Untouched']);
    expect(page2.pageInfo.hasMore).toBe(false);
  });

  it('sets and clears the repository connection pointer', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const connectionId = new mongoose.Types.ObjectId();
    const created = await createProject(orgId, {
      name: 'Repo Pointer',
      sourceType: 'repository',
      createdBy: actor,
    });

    const pointed = await updateProjectSourceConfig(orgId, String(created._id), {
      repositoryConnectionId: String(connectionId),
      sourceType: 'repository',
      updatedBy: String(actor),
    });
    expect(String(pointed.sourceConfig.repositoryConnectionId)).toBe(String(connectionId));

    const cleared = await updateProjectSourceConfig(orgId, String(created._id), {
      repositoryConnectionId: null,
      sourceType: 'repository',
      updatedBy: String(actor),
    });
    expect(cleared.sourceConfig.repositoryConnectionId).toBeNull();
    expect(
      await updateProjectSourceConfig(orgId, 'not-an-id', {
        repositoryConnectionId: String(connectionId),
      }),
    ).toBeNull();
  });

  it('increments and floors conversation counts', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const created = await createProject(orgId, {
      name: 'Counts',
      sourceType: 'upload',
      createdBy: actor,
    });
    const up = await adjustProjectConversationCount(orgId, String(created._id), 2);
    expect(up.counts.conversations).toBe(2);
    const down = await adjustProjectConversationCount(orgId, String(created._id), -5);
    expect(down.counts.conversations).toBe(0);
    expect(await adjustProjectConversationCount(orgId, String(created._id), 0)).toBeNull();
    expect(await adjustProjectConversationCount(orgId, 'not-an-id', 1)).toBeNull();
  });
});
