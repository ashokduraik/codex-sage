/**
 * Job routes integration tests — list/detail ACL, pagination, unhappy paths.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { softDelete } from '../../../src/platform/data/index.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { PROJECT_MODELS } from '../../../src/modules/masters/projects.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nextTestUserCode, ensureTestRoles } from '../../identityFixtures.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { JOB_MODELS, Job, createPendingJob, JOB_ENQUEUED_MESSAGE, JOB_EVENT_CODE_ENQUEUED } from '../../../src/modules/masters/jobs.js';
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
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS, ...IDEMPOTENCY_MODELS, ...PROJECT_MODELS, ...JOB_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('jobs.routes', () => {
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

  it('lists and gets pending jobs with enqueued event; omits workerId', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');

    const created = await createProjectRequest(app, accessToken, { name: 'Jobs Project', sourceType: 'upload' }, 'idem-jobs-1');
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id;

    const { jobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
      correlationId: 'req_jobs_1',
    });

    await Job.updateOne({ _id: jobId }, { $set: { workerId: 'secret-worker' } });

    const listRes = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].jobStatus).toBe('pending');
    expect(listBody.items[0]).not.toHaveProperty('workerId');
    expect(listBody.items[0]).not.toHaveProperty('stageCheckpoint');
    expect(listBody.pageInfo.hasMore).toBe(false);

    const getRes = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/get/${jobId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const detail = getRes.json();
    expect(detail.id).toBe(jobId);
    expect(detail.projectId).toBe(projectId);
    expect(detail.correlationId).toBe('req_jobs_1');
    expect(detail.stageCheckpoint).toBeNull();
    expect(detail).not.toHaveProperty('workerId');
    expect(detail.events).toEqual([
      expect.objectContaining({
        eventCode: JOB_EVENT_CODE_ENQUEUED,
        severity: 'info',
        message: JOB_ENQUEUED_MESSAGE,
      }),
    ]);
  });

  it('returns 404 across orgs and for soft-deleted jobs; returns failed active jobs', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');

    const created = await createProjectRequest(app, accessToken, { name: 'Jobs ACL', sourceType: 'upload' }, 'idem-jobs-acl');
    const projectId = created.json().id;

    const { jobId: activeJobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    const { jobId: failedJobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    await Job.updateOne({ _id: failedJobId }, { $set: { jobStatus: 'failed', failureClass: 'temporary' } });

    const { jobId: deletedJobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    await softDelete(Job, { _id: deletedJobId, orgId: org._id });

    const listRes = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const ids = listRes.json().items.map((item) => item.id);
    expect(ids).toContain(activeJobId);
    expect(ids).toContain(failedJobId);
    expect(ids).not.toContain(deletedJobId);

    const deletedGet = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/get/${deletedJobId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deletedGet.statusCode).toBe(404);
    expect(deletedGet.json().error.code).toBe('JOB_NOT_FOUND');

    const foreignOrgId = new mongoose.Types.ObjectId();
    const foreignProjectId = new mongoose.Types.ObjectId();
    const { jobId: foreignJobId } = await createPendingJob({
      orgId: String(foreignOrgId),
      projectId: String(foreignProjectId),
      jobType: 'ingest',
    });
    const crossOrg = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/get/${foreignJobId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(crossOrg.statusCode).toBe(404);
    expect(crossOrg.json().error.code).toBe('JOB_NOT_FOUND');
  });

  it('rejects limit=0, unknown jobStatus, and unauthenticated access', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const created = await createProjectRequest(app, accessToken, { name: 'Jobs Validation', sourceType: 'upload' }, 'idem-jobs-val');
    const projectId = created.json().id;

    const unauth = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}`,
    });
    expect(unauth.statusCode).toBe(401);

    const zeroLimit = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}?limit=0`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(zeroLimit.statusCode).toBe(400);

    const badStatus = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}?jobStatus=not-real`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(badStatus.statusCode).toBe(400);

    const clamped = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}?limit=999`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(clamped.statusCode).toBe(200);
  });

  it('paginates list without duplicates and returns 404 for unknown project', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(app, accessToken, { name: 'Jobs Page', sourceType: 'upload' }, 'idem-jobs-page');
    const projectId = created.json().id;

    for (let i = 0; i < 3; i += 1) {
      await createPendingJob({
        orgId: String(org._id),
        projectId,
        jobType: 'ingest',
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}?limit=2`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.pageInfo.hasMore).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}?limit=2&cursor=${encodeURIComponent(body1.pageInfo.nextCursor)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.items).toHaveLength(1);
    expect(body2.pageInfo.hasMore).toBe(false);
    const allIds = [...body1.items, ...body2.items].map((item) => item.id);
    expect(new Set(allIds).size).toBe(3);

    const missingProject = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${new mongoose.Types.ObjectId().toHexString()}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('returns 404 when caller has no project access to the job', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug('default');
    await ensureTestRoles(org._id);
    const viewerRole = await findRoleByCode(org._id, 'VIEWER');
    const passwordHash = await hashPassword('viewerpass1');
    await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'viewer-jobs@example.com',
      displayName: 'Viewer Jobs',
      userStatus: 'active',
      passwordHash,
      roleIds: [viewerRole._id],
    });

    app = await readyApp();
    const admin = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const created = await createProjectRequest(app, admin.accessToken, { name: 'Restricted Jobs', sourceType: 'upload' }, 'idem-jobs-restricted');
    const projectId = created.json().id;
    const { jobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });

    // selected-mode: viewer has no membership on this project → 404 JOB_NOT_FOUND
    const { accessToken: viewerToken } = await login(app, 'viewer-jobs@example.com', 'viewerpass1');
    const listDenied = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/list/${projectId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(listDenied.statusCode).toBe(404);

    const getDenied = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/jobs/get/${jobId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(getDenied.statusCode).toBe(404);
    expect(getDenied.json().error.code).toBe('JOB_NOT_FOUND');
  });
});
