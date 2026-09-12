/**
 * Project routes integration tests via app.inject.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { API_BASE_PATH, buildApp } from '../../http/app.js';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { AUDIT_MODELS, listAuditEvents } from '../audit/index.js';
import { AUTH_MODELS } from '../auth/index.js';
import { hashPassword } from '../auth/passwordHasher.js';
import { IDEMPOTENCY_MODELS } from '../../platform/idempotency/index.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  createMembership,
  createUser,
  findBuiltInRole,
  findOrganizationBySlug,
  runBootstrapSeed,
} from '../identity/index.js';
import { PROJECT_MODELS, Project } from './index.js';

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...AUTH_MODELS,
    ...AUDIT_MODELS,
    ...IDEMPOTENCY_MODELS,
    ...PROJECT_MODELS,
  ],
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
      url: `${API_BASE_PATH}/auth/login`,
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
      url: `${API_BASE_PATH}/projects`,
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
    const memberRole = await findBuiltInRole(org._id, 'member');
    const passwordHash = await hashPassword('memberpass1');
    const member = await createUser(org._id, {
      email: 'member-proj@example.com',
      displayName: 'Member',
      userStatus: 'active',
      passwordHash,
    });
    await createMembership(org._id, {
      userId: member._id,
      roleIds: [memberRole._id],
    });

    app = await readyApp();
    const unauth = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects`,
    });
    expect(unauth.statusCode).toBe(401);

    const { accessToken } = await login(app, 'member-proj@example.com', 'memberpass1');
    const forbidden = await createProjectRequest(
      app,
      accessToken,
      { name: 'Nope', sourceType: 'upload' },
      'idem-member-1',
    );
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
    const uploadRes = await createProjectRequest(
      app,
      accessToken,
      uploadPayload,
      'idem-upload-1',
    );
    expect(uploadRes.statusCode).toBe(201);
    const uploadBody = uploadRes.json();
    expect(uploadBody.lifecycleStatus).toBe('awaiting_source');
    expect(uploadBody.knowledgeHealth).toBe('none');

    const replay = await createProjectRequest(
      app,
      accessToken,
      uploadPayload,
      'idem-upload-1',
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(uploadBody.id);
    expect(await Project.countDocuments({ orgId: org._id, name: 'Upload One' })).toBe(1);

    const repoRes = await createProjectRequest(
      app,
      accessToken,
      { name: 'Repo One', sourceType: 'repository' },
      'idem-repo-1',
    );
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
      // eslint-disable-next-line no-await-in-loop
      const res = await createProjectRequest(
        app,
        accessToken,
        { name: `Page ${i}`, sourceType: 'upload' },
        `idem-page-${i}`,
      );
      expect(res.statusCode).toBe(201);
      ids.push(res.json().id);
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?limit=2`,
      headers,
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.pageInfo.hasMore).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?limit=2&cursor=${encodeURIComponent(body1.pageInfo.nextCursor)}`,
      headers,
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items).toHaveLength(2);

    const archiveRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${ids[0]}/archive`,
      headers,
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().lifecycleStatus).toBe('archived');

    const activeList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?limit=20`,
      headers,
    });
    expect(activeList.json().items.every((row) => row.lifecycleStatus !== 'archived')).toBe(
      true,
    );

    const archivedList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?includeArchived=true&limit=20`,
      headers,
    });
    expect(
      archivedList.json().items.some((row) => row.lifecycleStatus === 'archived'),
    ).toBe(true);

    const restoreRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${ids[0]}/restore`,
      headers,
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().lifecycleStatus).toBe('awaiting_source');

    const badPatch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${ids[1]}`,
      headers,
      payload: { lifecycleStatus: 'knowledge_ready' },
    });
    expect(badPatch.statusCode).toBe(400);
    expect(badPatch.json().error.code).toBe('VALIDATION_ERROR');
    expect(
      badPatch.json().error.details.some((d) => String(d.path).includes('lifecycleStatus')),
    ).toBe(true);

    const goodPatch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${ids[1]}`,
      headers,
      payload: { name: 'Renamed', description: 'updated' },
    });
    expect(goodPatch.statusCode).toBe(200);
    expect(goodPatch.json().name).toBe('Renamed');

    const badSettings = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${ids[1]}/settings`,
      headers,
      payload: { settings: { mystery: 1 } },
    });
    expect(badSettings.statusCode).toBe(400);
    expect(badSettings.json().error.code).toBe('UNKNOWN_SETTING');

    const emptySettings = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${ids[1]}/settings`,
      headers,
      payload: { settings: {} },
    });
    expect(emptySettings.statusCode).toBe(200);

    const preview = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${ids[1]}/deletion-preview`,
      headers,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().counts.sourceVersions).toBe(0);
    expect(preview.json().consequences.length).toBe(5);

    const del = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/projects/${ids[1]}`,
      headers,
    });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${ids[1]}`,
      headers,
    });
    expect(gone.statusCode).toBe(404);

    const deleteAudits = await listAuditEvents(org._id, { action: 'project.delete' });
    expect(deleteAudits.items.length).toBeGreaterThanOrEqual(1);

    // Soft-deleted rows never appear in list
    const afterDelete = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?includeArchived=true&limit=50`,
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
      url: `${API_BASE_PATH}/projects/${foreignId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(404);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${foreignId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'X' },
    });
    expect(patchRes.statusCode).toBe(404);
  });
});
