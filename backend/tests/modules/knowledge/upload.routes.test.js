/**
 * Source upload route integration tests — GridFS, jobs, ACL, idempotency.
 */
import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { JOB_MODELS, Job } from '../../../src/modules/masters/jobs.js';
import { clearSourceFilesBucket } from '../../clearSourceFilesBucket.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nextTestUserCode, ensureTestRoles } from '../../identityFixtures.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { PROJECT_MODELS, Project } from '../../../src/modules/masters/projects.js';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import { SOURCE_MODELS, SourceFile, SourceVersion, getSourceFilesBucket } from '../../../src/modules/knowledge/sources.js';
import {
  findRoleByCode,
  IDENTITY_MODELS,
  createUserInRepo,
  runBootstrapSeed,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  findOrganizationBySlug,
} from '../../../src/modules/masters/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS, ...IDEMPOTENCY_MODELS, ...PROJECT_MODELS, ...JOB_MODELS, ...SOURCE_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('source upload routes', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await harness.afterEach();
    await clearSourceFilesBucket();
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

  /**
   * Builds a multipart/form-data body with a single archive part.
   * @param {Buffer} zipBuffer Zip bytes.
   * @param {string} [filename] Part filename.
   * @returns {{ payload: Buffer, contentType: string }}
   */
  function buildArchiveMultipart(zipBuffer, filename = 'project.zip') {
    const boundary = `----CodexSageUpload${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\n` + `Content-Disposition: form-data; name="archive"; filename="${filename}"\r\n` + `Content-Type: application/zip\r\n\r\n`,
      'utf8',
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return {
      payload: Buffer.concat([header, zipBuffer, footer]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  /**
   * @param {import('fastify').FastifyInstance} instance
   * @param {{
   *   accessToken: string,
   *   projectId: string,
   *   zipBuffer: Buffer,
   *   idempotencyKey?: string,
   * }} input
   */
  async function uploadSource(instance, input) {
    const multipart = buildArchiveMultipart(input.zipBuffer);
    /** @type {Record<string, string>} */
    const headers = {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': multipart.contentType,
    };
    if (input.idempotencyKey) {
      headers['idempotency-key'] = input.idempotencyKey;
    }
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${input.projectId}/sources`,
      headers,
      payload: multipart.payload,
    });
  }

  it('happy zip stores GridFS, SourceFile, pending job, and returns 202', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(app, accessToken, { name: 'Upload Happy', sourceType: 'upload' }, 'idem-upload-proj-happy');
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id;
    expect(created.json().lifecycleStatus).toBe('awaiting_source');

    const zipBuffer = await readFile(path.join(fixturesDir, 'good.zip'));
    const res = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-happy-1',
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['jobId', 'sourceVersionId']);
    expect(mongoose.isValidObjectId(body.sourceVersionId)).toBe(true);
    expect(mongoose.isValidObjectId(body.jobId)).toBe(true);

    const version = await SourceVersion.findOne({
      _id: body.sourceVersionId,
      orgId: org._id,
    }).exec();
    expect(version).toBeTruthy();
    expect(version.origin).toBe('upload');
    expect(version.versionLifecycle).toBe('received');
    expect(version.fileCounts.accepted).toBeGreaterThan(0);
    expect(String(version.jobId)).toBe(body.jobId);

    const files = await SourceFile.find({
      orgId: org._id,
      sourceVersionId: body.sourceVersionId,
    }).exec();
    expect(files.length).toBe(version.fileCounts.accepted);

    const bucketFiles = await getSourceFilesBucket().find({}).toArray();
    expect(bucketFiles).toHaveLength(files.length);
    for (const file of files) {
      expect(bucketFiles.some((row) => String(row._id) === String(file.gridFsId))).toBe(true);
    }

    const job = await Job.findById(body.jobId).exec();
    expect(job.jobStatus).toBe('pending');
    expect(job.jobType).toBe('ingest');
    expect(String(job.sourceVersionId)).toBe(body.sourceVersionId);

    const project = await Project.findById(projectId).exec();
    expect(project.lifecycleStatus).toBe('source_received');

    const audits = await listAuditEvents(org._id, {
      action: 'source.upload',
      limit: 10,
    });
    const uploadAudit = audits.items.find((row) => row.resourceId === body.sourceVersionId);
    expect(uploadAudit).toBeTruthy();
    expect(uploadAudit.context.acceptedCount).toBeGreaterThan(0);
    expect(uploadAudit.context).toHaveProperty('skippedCount');
    expect(uploadAudit.context).not.toHaveProperty('bytes');
  });

  it('returns 400 with no writes when zip only has ignored paths', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(app, accessToken, { name: 'Upload Ignored', sourceType: 'upload' }, 'idem-upload-proj-ignored');
    const projectId = created.json().id;
    const zipBuffer = await readFile(path.join(fixturesDir, 'only-ignored.zip'));

    const res = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-ignored-1',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS');
    expect(await SourceVersion.countDocuments({ orgId: org._id })).toBe(0);
    expect(await Job.countDocuments({ orgId: org._id })).toBe(0);
    expect(await getSourceFilesBucket().find({}).toArray()).toHaveLength(0);
  });

  it('returns 400 with no writes on zip-slip', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(app, accessToken, { name: 'Upload Slip', sourceType: 'upload' }, 'idem-upload-proj-slip');
    const projectId = created.json().id;
    const zipBuffer = await readFile(path.join(fixturesDir, 'slip.zip'));

    const res = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-slip-1',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SOURCE_ZIP_SLIP');
    expect(await SourceVersion.countDocuments({ orgId: org._id })).toBe(0);
    expect(await getSourceFilesBucket().find({}).toArray()).toHaveLength(0);
  });

  it('replays the same Idempotency-Key without a second writer', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(app, accessToken, { name: 'Upload Idem', sourceType: 'upload' }, 'idem-upload-proj-idem');
    const projectId = created.json().id;
    const zipBuffer = await readFile(path.join(fixturesDir, 'valid-small.zip'));

    const first = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-replay-1',
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();

    const second = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-replay-1',
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(firstBody);

    expect(await SourceVersion.countDocuments({ orgId: org._id })).toBe(1);
    expect(await Job.countDocuments({ orgId: org._id, jobType: 'ingest' })).toBe(1);
  });

  it('returns 404 for a cross-tenant project id', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const zipBuffer = await readFile(path.join(fixturesDir, 'valid-small.zip'));
    const foreignProjectId = new mongoose.Types.ObjectId().toString();

    const res = await uploadSource(app, {
      accessToken,
      projectId: foreignProjectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-cross-1',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('returns 403 when the caller lacks sources.upload', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken: adminToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(app, adminToken, { name: 'Upload Forbidden', sourceType: 'upload' }, 'idem-upload-proj-forbidden');
    const projectId = created.json().id;

    await ensureTestRoles(org._id);
    const viewerRole = await findRoleByCode(org._id, 'VIEWER');
    const passwordHash = await hashPassword('ViewerPass1!');
    const viewer = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'viewer-upload@example.com',
      displayName: 'Viewer Upload',
      passwordHash,
      userStatus: 'active',
      createdBy: null,
      roleIds: [viewerRole._id],
    });
    await addProjectMember({
      orgId: String(org._id),
      projectId,
      userId: String(viewer._id),
      actorUserId: String(viewer._id),
      roleId: String(viewerRole._id),
      correlationId: 'corr-viewer-member',
      log: createMockLog(),
    });

    const { accessToken: viewerToken } = await login(app, 'viewer-upload@example.com', 'ViewerPass1!');
    const zipBuffer = await readFile(path.join(fixturesDir, 'valid-small.zip'));
    const res = await uploadSource(app, {
      accessToken: viewerToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-forbidden-1',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('returns 400 when Idempotency-Key is missing', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const created = await createProjectRequest(app, accessToken, { name: 'Upload No Key', sourceType: 'upload' }, 'idem-upload-proj-nokey');
    const projectId = created.json().id;
    const zipBuffer = await readFile(path.join(fixturesDir, 'valid-small.zip'));

    const res = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('allows a second upload without changing lifecycle when already source_received', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const created = await createProjectRequest(app, accessToken, { name: 'Upload Twice', sourceType: 'upload' }, 'idem-upload-proj-twice');
    const projectId = created.json().id;
    const zipBuffer = await readFile(path.join(fixturesDir, 'valid-small.zip'));

    const first = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-twice-1',
    });
    expect(first.statusCode).toBe(202);

    const second = await uploadSource(app, {
      accessToken,
      projectId,
      zipBuffer,
      idempotencyKey: 'idem-upload-twice-2',
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().sourceVersionId).not.toBe(first.json().sourceVersionId);

    expect(await SourceVersion.countDocuments({ orgId: org._id })).toBe(2);
    const project = await Project.findById(projectId).exec();
    expect(project.lifecycleStatus).toBe('source_received');
  });

  it('returns 400 when the archive multipart field is missing', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const created = await createProjectRequest(app, accessToken, { name: 'Upload Bad Field', sourceType: 'upload' }, 'idem-upload-proj-badfield');
    const projectId = created.json().id;
    const boundary = `----CodexSageUpload${Date.now()}`;
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="x.zip"\r\n` +
        `Content-Type: application/zip\r\n\r\n` +
        `not-a-zip\r\n` +
        `--${boundary}--\r\n`,
      'utf8',
    );

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${projectId}/sources`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-upload-badfield-1',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
