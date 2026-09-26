/**
 * Source preview and change-summary route integration tests.
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
  createRoleInRepo,
  createUser, createUserInRepo,
  findOrganizationBySlug,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { PROJECT_MODELS } from '../../../src/modules/masters/projects.js';
import { Project } from '../../../src/models/projects.model.js';
import { addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { DOCUMENT_MODELS } from '../../../src/modules/knowledge/documents.js';
import { KNOWLEDGE_MODELS, insertKnowledgeVersion } from '../../../src/modules/knowledge/knowledge.js';
import {
  SOURCE_MODELS,
  clearSourceFilesBucket,
  getSourceFilesBucket,
  insertSourceFiles,
  insertSourceVersion,
} from '../../../src/modules/knowledge/sources.js';
import { upsertChangeSummary } from '../../../src/modules/knowledge/changeSummary.js';
import { EXCLUSION_RULESET_ID } from '../../../src/modules/knowledge/uploads.js';

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...AUTH_MODELS,
    ...AUDIT_MODELS,
    ...IDEMPOTENCY_MODELS,
    ...PROJECT_MODELS,
    ...KNOWLEDGE_MODELS,
    ...DOCUMENT_MODELS,
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

describe('source preview and change-summary routes', () => {
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
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} email Email.
   * @param {string} password Password.
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
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} name Project name.
   * @param {string} idempotencyKey Idempotency key.
   */
  async function createProject(instance, accessToken, name, idempotencyKey) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { name, sourceType: 'upload' },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  /**
   * Publishes a ready knowledge version with one GridFS-backed source file.
   * @param {{ orgId: string, projectId: string, path?: string, body?: string, excluded?: boolean }} input Scope.
   */
  async function seedFile(input) {
    const sourceVersionId = new mongoose.Types.ObjectId().toString();
    const actorId = new mongoose.Types.ObjectId().toString();
    const filePath = input.path ?? 'src/payments/refund.js';
    const body = input.body ?? 'line1\nline2\nline3\nline4\n';
    await insertSourceVersion({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: actorId,
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: input.excluded ? 1 : 0 },
    });
    const bucket = getSourceFilesBucket();
    const upload = bucket.openUploadStream(`${input.orgId}/${input.projectId}/${sourceVersionId}/${filePath}`);
    upload.end(Buffer.from(body));
    await new Promise((resolve, reject) => {
      upload.on('finish', resolve);
      upload.on('error', reject);
    });
    await insertSourceFiles({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      createdBy: actorId,
      files: [
        {
          path: filePath,
          sha256: 'b'.repeat(64),
          byteLength: Buffer.byteLength(body),
          kind: 'code',
          gridFsId: upload.id,
          excludedFromGraph: Boolean(input.excluded),
          exclusionReason: input.excluded ? 'over_graph_size_limit' : null,
        },
      ],
    });
    const inserted = await insertKnowledgeVersion({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      graphIdentity: {
        graphHash: 'h1',
        indexedAt: new Date().toISOString(),
        sourceVersionId,
        indexedFileCount: 1,
        skippedFileCount: 0,
        mode: 'indexAll',
        graphDir: '.codegraph',
      },
      publishedHealth: 'ready',
      excludedFileCount: input.excluded ? 1 : 0,
    });
    await Project.updateOne(
      { _id: input.projectId },
      {
        $set: {
          lifecycleStatus: 'knowledge_ready',
          knowledgeHealth: 'ready',
          currentKnowledgeVersionId: inserted._id,
        },
      },
    );
    return { knowledgeVersionId: String(inserted._id), sourceVersionId, filePath };
  }

  it('returns file metadata and a line slice', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Preview Ready', 'idem-preview-ready');
    const seeded = await seedFile({
      orgId: String(org._id),
      projectId: project.id,
      excluded: true,
    });

    const meta = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files?path=${encodeURIComponent(seeded.filePath)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({
      path: seeded.filePath,
      excludedFromGraph: true,
      previewAvailable: true,
      knowledgeVersionId: seeded.knowledgeVersionId,
    });

    const slice = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files/slice?path=${encodeURIComponent(seeded.filePath)}&startLine=2&endLine=3`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(slice.statusCode).toBe(200);
    expect(slice.json().content).toBe('line2\nline3');
    expect(slice.json().excludedFromGraph).toBe(true);
  });

  it('returns 400 for unsafe paths and inverted line ranges', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Preview Bad', 'idem-preview-bad');
    await seedFile({ orgId: String(org._id), projectId: project.id });

    const unsafe = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files?path=${encodeURIComponent('../etc/passwd')}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(unsafe.statusCode).toBe(400);

    const range = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files/slice?path=src/payments/refund.js&startLine=4&endLine=1`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(range.statusCode).toBe(400);

    const missingPath = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(missingPath.statusCode).toBe(400);

    const missingSlice = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files/slice?path=src/payments/refund.js`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(missingSlice.statusCode).toBe(400);
  });

  it('returns 404 for a missing file and 403 without sources.preview', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken: adminToken } = await login(
      app,
      DEFAULT_ADMIN_EMAIL,
      DEFAULT_ADMIN_PASSWORD,
    );
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, adminToken, 'Preview ACL', 'idem-preview-acl');
    await seedFile({ orgId: String(org._id), projectId: project.id });

    const missing = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files?path=nope.js`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(missing.statusCode).toBe(404);

    const role = await createRoleInRepo(org._id, {
      name: 'No preview',
      permissions: ['org.view', 'projects.view'],
      createdBy: null,
    });
    const passwordHash = await hashPassword('NoPreviewPass1!');
    const user = await createUserInRepo(org._id, {
      email: 'nopreview@example.com',
      displayName: 'No Preview',
      passwordHash,
      userStatus: 'active',
      createdBy: null,
          roleIds: [role._id]
        });
    await addProjectMember({
      orgId: String(org._id),
      projectId: project.id,
      userId: String(user._id),
      actorUserId: String(user._id),
      roleId: String(role._id),
      correlationId: 'corr-preview-403',
      log: createMockLog(),
    });
    const { accessToken } = await login(app, 'nopreview@example.com', 'NoPreviewPass1!');
    const forbidden = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/files?path=src/payments/refund.js`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('returns the latest change summary and 404 when none exists', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Changes Ready', 'idem-changes-ready');
    const seeded = await seedFile({ orgId: String(org._id), projectId: project.id });
    await upsertChangeSummary({
      orgId: org._id,
      projectId: project.id,
      sourceVersionId: seeded.sourceVersionId,
      knowledgeVersionId: seeded.knowledgeVersionId,
      added: ['src/payments/refund.js'],
      removed: [],
      changed: ['src/app.js'],
      unchanged: [],
      counts: { added: 1, removed: 0, changed: 1, unchanged: 0 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/updates/latest`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      counts: { added: 1, modified: 1, removed: 0 },
      impact: { apisChanged: null, workflowsChanged: null, documentationConflicts: 0 },
      conflicts: [],
    });
    expect(res.json().paths.modified[0].path).toBe('src/app.js');

    const emptyProject = await createProject(app, accessToken, 'Changes Empty', 'idem-changes-empty');
    const empty = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${emptyProject.id}/knowledge/updates/latest`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(empty.statusCode).toBe(404);
  });
});
