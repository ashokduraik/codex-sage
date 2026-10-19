/**
 * Project routes integration tests via app.inject.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nextTestUserCode, ensureTestRoles } from '../../identityFixtures.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { PROJECT_MODELS, Project } from '../../../src/modules/masters/projects.js';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import {
  findRoleByCode,
  IDENTITY_MODELS,
  createUserInRepo,
  runBootstrapSeed,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  findOrganizationBySlug,
} from '../../../src/modules/masters/index.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS, ...IDEMPOTENCY_MODELS, ...PROJECT_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('projects.routes', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  /**
   * @returns {Promise<import('fastify').FastifyInstance>}
   */
  async function readyApp() {
    const instance = buildApp(TEST_APP_CONFIG);
    await instance.ready();
    return instance;
  }

  /**
   * @param {import('fastify').FastifyInstance} instance
   * @param {string} email
   * @param {string} password
   */
  async function login(instance, email, password) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/access/auth/login`,
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /**
   * @param {import('fastify').FastifyInstance} instance
   * @param {string} accessToken
   * @param {object} payload
   * @param {string} idempotencyKey
   */
  async function createProjectRequest(instance, accessToken, payload, idempotencyKey) {
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/create`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
  }

  it('returns 401 unauthenticated and 403 without projects.create', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    await ensureTestRoles(org._id);
    const memberRole = await findRoleByCode(org._id, 'MEMBER');
    const passwordHash = await hashPassword('memberpass1');
    await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'member-proj@example.com',
      displayName: 'Member',
      userStatus: 'active',
      passwordHash,
      roleIds: [memberRole._id],
    });

    app = await readyApp();
    const unauth = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/list`,
    });
    expect(unauth.statusCode).toBe(401);

    const { accessToken } = await login(app, 'member-proj@example.com', 'memberpass1');
    const forbidden = await createProjectRequest(app, accessToken, { name: 'Nope', sourceType: 'upload' }, 'idem-member-1');
    expect(forbidden.statusCode).toBe(403);
  });

  it('creates upload/repository projects, echoes idempotency, and ignores forged orgId', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');

    const uploadPayload = {
      name: 'Upload One',
      description: 'demo',
      sourceType: 'upload',
      orgId: new mongoose.Types.ObjectId().toHexString(),
    };
    const uploadRes = await createProjectRequest(app, accessToken, uploadPayload, 'idem-upload-1');
    expect(uploadRes.statusCode).toBe(201);
    const uploadBody = uploadRes.json();
    expect(uploadBody.lifecycleStatus).toBe('awaiting_source');
    expect(uploadBody.knowledgeHealth).toBe('none');

    const replay = await createProjectRequest(app, accessToken, uploadPayload, 'idem-upload-1');
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(uploadBody.id);
    expect(await Project.countDocuments({ orgId: org._id, name: 'Upload One' })).toBe(1);

    const repoRes = await createProjectRequest(app, accessToken, { name: 'Repo One', sourceType: 'repository' }, 'idem-repo-1');
    expect(repoRes.statusCode).toBe(201);
    expect(repoRes.json().lifecycleStatus).toBe('connecting_repository');

    const createAudits = await listAuditEvents(org._id, { action: 'project.create' });
    expect(createAudits.items.length).toBeGreaterThanOrEqual(2);
  });

  it('lists with pagination, archived filter, patch rejection, settings, delete preview', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const headers = { authorization: `Bearer ${accessToken}` };

    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await createProjectRequest(app, accessToken, { name: `Page ${i}`, sourceType: 'upload' }, `idem-page-${i}`);
      expect(res.statusCode).toBe(201);
      ids.push(res.json().id);
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/list?limit=2`,
      headers,
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.pageInfo.hasMore).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/list?limit=2&cursor=${encodeURIComponent(body1.pageInfo.nextCursor)}`,
      headers,
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items).toHaveLength(2);

    const archiveRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/archive`,
      payload: { projectId: ids[0] },
      headers,
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().lifecycleStatus).toBe('archived');

    const activeList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/list?limit=20`,
      headers,
    });
    expect(activeList.json().items.every((row) => row.lifecycleStatus !== 'archived')).toBe(true);

    const archivedList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/list?includeArchived=true&limit=20`,
      headers,
    });
    expect(archivedList.json().items.some((row) => row.lifecycleStatus === 'archived')).toBe(true);

    const restoreRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/restore`,
      payload: { projectId: ids[0] },
      headers,
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().lifecycleStatus).toBe('awaiting_source');

    const badPatch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/masters/projects/update`,
      headers,
      payload: { projectId: ids[1], lifecycleStatus: 'knowledge_ready' },
    });
    expect(badPatch.statusCode).toBe(400);
    expect(badPatch.json().error.code).toBe('VALIDATION_ERROR');
    expect(badPatch.json().error.details.some((d) => String(d.path).includes('lifecycleStatus'))).toBe(true);

    const goodPatch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/masters/projects/update`,
      headers,
      payload: { projectId: ids[1], name: 'Renamed', description: 'updated' },
    });
    expect(goodPatch.statusCode).toBe(200);
    expect(goodPatch.json().name).toBe('Renamed');

    const badSettings = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/masters/projects/updateSettings`,
      headers,
      payload: { projectId: ids[1], settings: { mystery: 1 } },
    });
    expect(badSettings.statusCode).toBe(400);
    expect(badSettings.json().error.code).toBe('UNKNOWN_SETTING');

    const emptySettings = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/masters/projects/updateSettings`,
      headers,
      payload: { projectId: ids[1], settings: {} },
    });
    expect(emptySettings.statusCode).toBe(200);

    const accessRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/masters/projects/recordAccess`,
      payload: { projectId: ids[0] },
      headers,
    });
    expect(accessRes.statusCode).toBe(200);
    expect(accessRes.json().lastAccessedAt).toBeTruthy();

    const recentList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/list?sort=lastAccessedAt&limit=5`,
      headers,
    });
    expect(recentList.statusCode).toBe(200);
    expect(recentList.json().items[0].id).toBe(ids[0]);

    const preview = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/getDeletionPreview/${ids[1]}`,
      headers,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().counts.sourceVersions).toBe(0);
    expect(preview.json().consequences.length).toBe(5);

    const del = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/masters/projects/delete`,
      payload: { projectId: ids[1] },
      headers,
    });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/get/${ids[1]}`,
      headers,
    });
    expect(gone.statusCode).toBe(404);

    const deleteAudits = await listAuditEvents(org._id, { action: 'project.delete' });
    expect(deleteAudits.items.length).toBeGreaterThanOrEqual(1);

    // Soft-deleted rows never appear in list
    const afterDelete = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/list?includeArchived=true&limit=50`,
      headers,
    });
    expect(afterDelete.json().items.every((row) => row.id !== ids[1])).toBe(true);
  });

  it('returns 404 for cross-tenant project access', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const foreignId = new mongoose.Types.ObjectId().toHexString();
    const getRes = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/projects/get/${foreignId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(404);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/masters/projects/update`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { projectId: foreignId, name: 'X' },
    });
    expect(patchRes.statusCode).toBe(404);
  });
});
