/**
 * Job control routes integration tests — retry, cancel, ACL, idempotency.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import mongoose from 'mongoose';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { ApiError } from '../../../src/platform/errors.js';
import { parseJobControlParams, zodDetails } from '../../../src/modules/masters/jobs.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { AUTH_MODELS } from '../../../src/modules/access/auth.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { softDelete } from '../../../src/platform/data/index.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  createMembership,
  createUser, createUserInRepo,
  findBuiltInRole,
  findOrganizationBySlug,
  findUserByEmail,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { PROJECT_MODELS, Project } from '../../../src/modules/masters/projects.js';
import { PROJECT_MEMBER_MODELS, addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import {
  JOB_MODELS,
  Job,
  JobEvent,
  createPendingJob,
} from '../../../src/modules/masters/jobs.js';

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...AUTH_MODELS,
    ...AUDIT_MODELS,
    ...IDEMPOTENCY_MODELS,
    ...PROJECT_MODELS,
    ...PROJECT_MEMBER_MODELS,
    ...JOB_MODELS,
  ],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('jobControl.routes', () => {
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

  it('retries a failed job, preserves failure events, and replays Idempotency-Key', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Retry Project', sourceType: 'upload' },
      'idem-ctrl-proj-1',
    );
    const projectId = created.json().id;
    const { jobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });

    await Job.updateOne(
      { _id: jobId },
      {
        $set: {
          jobStatus: 'failed',
          failureClass: 'temporary',
          currentStage: 'materialize_docs',
          stageCheckpoint: {
            lastCompletedStage: 'exclude_apply',
            updatedAt: new Date(),
          },
          completedAt: new Date(),
        },
      },
    );
    await JobEvent.create({
      orgId: org._id,
      projectId,
      jobId,
      eventCode: 'DOCUMENT_PARSE_FAILED',
      severity: 'error',
      message: 'Documentation analysis failed.',
      data: { affectedCount: 9 },
    });

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${jobId}/retry`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-retry-same-1',
      },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      jobId,
      jobStatus: 'retrying',
      alreadyActive: false,
      retry: { mode: 'resume', fromStage: 'materialize_docs' },
    });

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${jobId}/retry`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-retry-same-1',
      },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());

    const detail = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/jobs/${jobId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.stages.length).toBeGreaterThan(0);
    expect(body.events.some((event) => event.eventCode === 'DOCUMENT_PARSE_FAILED')).toBe(true);
    expect(body.events.some((event) => event.eventCode === 'job.retry_requested')).toBe(true);
    expect(body.retry.available).toBe(false);
  });

  it('returns alreadyActive on a second retry without sharing a key', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Active Retry', sourceType: 'upload' },
      'idem-ctrl-proj-2',
    );
    const projectId = created.json().id;
    const { jobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    await Job.updateOne(
      { _id: jobId },
      {
        $set: {
          jobStatus: 'failed',
          failureClass: 'temporary',
          currentStage: 'materialize_docs',
          stageCheckpoint: { lastCompletedStage: 'exclude_apply', updatedAt: new Date() },
        },
      },
    );

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${jobId}/retry`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-retry-a',
      },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${jobId}/retry`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-retry-b',
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyActive).toBe(true);
    expect(second.json().jobId).toBe(jobId);
  });

  it('rejects not_retryable and completed transitions', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Reject Retry', sourceType: 'upload' },
      'idem-ctrl-proj-3',
    );
    const projectId = created.json().id;

    const { jobId: badUploadId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    await Job.updateOne(
      { _id: badUploadId },
      {
        $set: {
          jobStatus: 'failed',
          failureClass: 'user_action_required',
          currentStage: 'validate_upload',
        },
      },
    );
    const notRetryable = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${badUploadId}/retry`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-retry-bad',
      },
    });
    expect(notRetryable.statusCode).toBe(409);
    expect(notRetryable.json().error.code).toBe('JOB_NOT_RETRYABLE');

    const { jobId: completedId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    await Job.updateOne({ _id: completedId }, { $set: { jobStatus: 'completed' } });
    const completed = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${completedId}/retry`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-retry-done',
      },
    });
    expect(completed.statusCode).toBe(409);
    expect(completed.json().error.code).toBe('INVALID_JOB_TRANSITION');
  });

  it('cancels pending immediately and requests cancel for running', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Cancel Project', sourceType: 'upload' },
      'idem-ctrl-proj-4',
    );
    const projectId = created.json().id;

    const { jobId: pendingId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    const pendingCancel = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${pendingId}/cancel`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(pendingCancel.statusCode).toBe(200);
    expect(pendingCancel.json().jobStatus).toBe('cancelled');

    const { jobId: runningId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    await Job.updateOne(
      { _id: runningId },
      { $set: { jobStatus: 'running', workerId: 'w1', startedAt: new Date() } },
    );
    const runningCancel = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${runningId}/cancel`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(runningCancel.statusCode).toBe(202);
    expect(runningCancel.json()).toMatchObject({
      jobId: runningId,
      jobStatus: 'running',
      cancellation: { requested: true },
    });
    const refreshed = await Job.findById(runningId).lean().exec();
    expect(refreshed.cancelRequestedAt).toBeTruthy();
    expect(refreshed.jobStatus).toBe('running');
  });

  it('rejects missing Idempotency-Key on retry', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const missingKey = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/665f1c9d4b2a8e0012a4f001/retry`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(missingKey.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('enforces authz and soft-deleted project rules', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(
      app,
      accessToken,
      { name: 'Authz Project', sourceType: 'upload' },
      'idem-ctrl-proj-5',
    );
    const projectId = created.json().id;
    const { jobId } = await createPendingJob({
      orgId: String(org._id),
      projectId,
      jobType: 'ingest',
    });
    await Job.updateOne(
      { _id: jobId },
      {
        $set: {
          jobStatus: 'failed',
          failureClass: 'temporary',
          currentStage: 'materialize_docs',
          stageCheckpoint: { lastCompletedStage: 'exclude_apply', updatedAt: new Date() },
        },
      },
    );

    const unauth = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${jobId}/retry`,
      headers: { 'idempotency-key': 'idem-unauth' },
    });
    expect(unauth.statusCode).toBe(401);

    const passwordHash = await hashPassword('ViewerPass1!');
    const viewer = await createUserInRepo(org._id, {
      email: 'viewer-ctrl@example.com',
      displayName: 'Viewer Ctrl',
      userStatus: 'active',
      passwordHash,
    });
    const viewerRole = await findBuiltInRole(org._id, 'viewer');
    await createMembership(org._id, {
      userId: viewer._id,
      roleIds: [viewerRole._id],
    });
    const adminUser = await findUserByEmail(org._id, DEFAULT_ADMIN_EMAIL);
    await addProjectMember({
      orgId: String(org._id),
      actorUserId: String(adminUser._id),
      projectId,
      userId: String(viewer._id),
      permissions: ['projects.view'],
      correlationId: 'c-viewer-member',
      log: createMockLog(),
    });
    const { accessToken: viewerToken } = await login(
      app,
      'viewer-ctrl@example.com',
      'ViewerPass1!',
    );
    const forbidden = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${jobId}/retry`,
      headers: {
        authorization: `Bearer ${viewerToken}`,
        'idempotency-key': 'idem-viewer-retry',
      },
    });
    expect(forbidden.statusCode).toBe(403);

    const foreignJobId = new mongoose.Types.ObjectId().toHexString();
    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${foreignJobId}/cancel`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(missing.statusCode).toBe(404);

    await softDelete(Project, { _id: projectId, orgId: org._id });
    const deletedProject = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/jobs/${jobId}/retry`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-deleted-project',
      },
    });
    expect(deletedProject.statusCode).toBe(404);
  });
});

describe('parseJobControlParams', () => {
  it('accepts a non-empty jobId', () => {
    expect(parseJobControlParams({ jobId: '665f1c9d4b2a8e0012a4f001' })).toEqual({
      jobId: '665f1c9d4b2a8e0012a4f001',
    });
  });

  it('rejects missing or empty jobId', () => {
    expect(() => parseJobControlParams({})).toThrow(ApiError);
    expect(() => parseJobControlParams({ jobId: '' })).toThrow(ApiError);
    try {
      parseJobControlParams(null);
      expect.fail('expected throw');
    } catch (error) {
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details[0].path).toBe('jobId');
    }
  });

  it('maps zod issues with an empty path to params', () => {
    const schema = z.string().min(1);
    const result = schema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(zodDetails(result.error, 'params')[0].path).toBe('params');
    }
  });
});
