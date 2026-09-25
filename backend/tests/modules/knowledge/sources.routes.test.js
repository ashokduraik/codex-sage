/**
 * Reingest route integration tests — ACL, idempotency, and 404 isolation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { AUTH_MODELS } from '../../../src/modules/access/auth.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  createUser, createUserInRepo,
  findBuiltInRole,
  findOrganizationBySlug,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { PROJECT_MODELS } from '../../../src/modules/masters/projects.js';
import { PROJECT_MEMBER_MODELS, addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { JOB_MODELS, Job } from '../../../src/modules/masters/jobs.js';
import { EXCLUSION_RULESET_ID } from '../../../src/modules/knowledge/uploads.js';
import { SOURCE_MODELS } from '../../../src/modules/knowledge/sources.js';
import { insertSourceVersion } from '../../../src/modules/knowledge/sources.js';

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...AUTH_MODELS,
    ...AUDIT_MODELS,
    ...IDEMPOTENCY_MODELS,
    ...PROJECT_MODELS,
    ...PROJECT_MEMBER_MODELS,
    ...JOB_MODELS,
    ...SOURCE_MODELS,
  ],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('source reingest routes', () => {
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

  it('returns 202 and replays the same jobId for a duplicate Idempotency-Key', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Reingest Happy', sourceType: 'upload' },
      'idem-reingest-proj-happy',
    );
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id;
    const sourceVersionId = new mongoose.Types.ObjectId();
    await insertSourceVersion({
      orgId: String(org._id),
      projectId,
      sourceVersionId: String(sourceVersionId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(org._id),
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${projectId}/sources/${sourceVersionId}/reingest`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-reingest-happy-1',
      },
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      sourceVersionId: String(sourceVersionId),
      jobType: 'reingest',
    });

    const replay = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${projectId}/sources/${sourceVersionId}/reingest`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-reingest-happy-1',
      },
      payload: {},
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().jobId).toBe(first.json().jobId);
    expect(await Job.countDocuments({ projectId, jobType: 'reingest' })).toBe(1);
  });

  it('returns 404 for a source version on another project', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Reingest 404', sourceType: 'upload' },
      'idem-reingest-proj-404',
    );
    const projectId = created.json().id;
    const otherVersionId = new mongoose.Types.ObjectId();
    await insertSourceVersion({
      orgId: String(org._id),
      projectId: String(new mongoose.Types.ObjectId()),
      sourceVersionId: String(otherVersionId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(org._id),
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${projectId}/sources/${otherVersionId}/reingest`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-reingest-404-1',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SOURCE_VERSION_NOT_FOUND');
    expect(await Job.countDocuments({ projectId })).toBe(0);
  });

  it('returns 403 when the caller lacks knowledge.trigger', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken: adminToken } = await login(
      app,
      DEFAULT_ADMIN_EMAIL,
      DEFAULT_ADMIN_PASSWORD,
    );
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      adminToken,
      { name: 'Reingest Forbidden', sourceType: 'upload' },
      'idem-reingest-proj-forbidden',
    );
    const projectId = created.json().id;
    const sourceVersionId = new mongoose.Types.ObjectId();
    await insertSourceVersion({
      orgId: String(org._id),
      projectId,
      sourceVersionId: String(sourceVersionId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(org._id),
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });

    const viewerRole = await findBuiltInRole(org._id, 'viewer');
    const passwordHash = await hashPassword('ViewerPass1!');
    const viewer = await createUserInRepo(org._id, {
      email: 'viewer-reingest@example.com',
      displayName: 'Viewer Reingest',
      passwordHash,
      userStatus: 'active',
      createdBy: null,
          roleIds: [viewerRole._id]
        });
    await addProjectMember({
      orgId: String(org._id),
      projectId,
      userId: String(viewer._id),
      actorUserId: String(viewer._id),
      roleId: String(viewerRole._id),
      correlationId: 'corr-viewer-reingest',
      log: createMockLog(),
    });

    const { accessToken: viewerToken } = await login(
      app,
      'viewer-reingest@example.com',
      'ViewerPass1!',
    );
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${projectId}/sources/${sourceVersionId}/reingest`,
      headers: {
        authorization: `Bearer ${viewerToken}`,
        'idempotency-key': 'idem-reingest-forbidden-1',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('lists source versions for a project with projects.view', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Source Versions List', sourceType: 'upload' },
      'idem-source-versions-list',
    );
    const projectId = created.json().id;
    const firstId = new mongoose.Types.ObjectId();
    const secondId = new mongoose.Types.ObjectId();
    await insertSourceVersion({
      orgId: String(org._id),
      projectId,
      sourceVersionId: String(firstId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(org._id),
      fileCounts: { accepted: 10, skipped: 2, excludedFromGraph: 1 },
    });
    await insertSourceVersion({
      orgId: String(org._id),
      projectId,
      sourceVersionId: String(secondId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(org._id),
      origin: 'repository',
      commitSha: 'abc123',
      branch: 'main',
      fileCounts: { accepted: 4, skipped: 0, excludedFromGraph: 0 },
    });

    const page1 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${projectId}/source-versions?limit=1`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().items).toHaveLength(1);
    expect(page1.json().pageInfo.hasMore).toBe(true);
    expect(page1.json().items[0]).toMatchObject({
      origin: 'repository',
      commitSha: 'abc123',
      branch: 'main',
    });

    const page2 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${projectId}/source-versions?limit=1&cursor=${encodeURIComponent(page1.json().pageInfo.nextCursor)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items).toHaveLength(1);
    expect(page2.json().pageInfo.hasMore).toBe(false);
  });

  it('rejects limit=0 on source-versions list', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Source Versions Limit', sourceType: 'upload' },
      'idem-source-versions-limit',
    );
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${created.json().id}/source-versions?limit=0`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
