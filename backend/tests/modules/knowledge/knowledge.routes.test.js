/**
 * Knowledge browse route integration tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  createRoleInRepo,
  createUserInRepo,
  findOrganizationBySlug,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { PROJECT_MODELS } from '../../../src/modules/masters/projects.js';
import { Project } from '../../../src/models/projects.model.js';
import { softDeleteProject } from '../../../src/modules/masters/projects.helper.js';
import { addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { DOCUMENT_MODELS, insertDocumentSections } from '../../../src/modules/knowledge/documents.js';
import { KNOWLEDGE_MODELS, insertKnowledgeVersion } from '../../../src/modules/knowledge/knowledge.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS, ...IDEMPOTENCY_MODELS, ...PROJECT_MODELS, ...KNOWLEDGE_MODELS, ...DOCUMENT_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('knowledge browse routes', () => {
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
   * Marks a project ready with a published knowledge version.
   * @param {{ orgId: string, projectId: string, excludedFileCount?: number, health?: string }} input Scope.
   */
  async function publishReady(input) {
    const sourceVersionId = new mongoose.Types.ObjectId();
    const inserted = await insertKnowledgeVersion({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: String(sourceVersionId),
      graphIdentity: {
        graphHash: 'h1',
        indexedAt: new Date().toISOString(),
        sourceVersionId: String(sourceVersionId),
        indexedFileCount: 2,
        skippedFileCount: input.excludedFileCount ?? 0,
        mode: 'indexAll',
        graphDir: '.codegraph',
      },
      publishedHealth: input.health === 'partially_available' ? 'partially_available' : 'ready',
      excludedFileCount: input.excludedFileCount ?? 0,
    });
    await Project.updateOne(
      { _id: input.projectId },
      {
        $set: {
          lifecycleStatus: input.health === 'partially_available' ? 'partially_available' : 'knowledge_ready',
          knowledgeHealth: input.health ?? 'ready',
          currentKnowledgeVersionId: inserted._id,
        },
      },
    );
    await insertDocumentSections({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      path: 'README.md',
      sections: [
        {
          heading: 'Overview',
          startLine: 1,
          endLine: 3,
          text: 'Payments service.',
          sectionIndex: 0,
        },
      ],
    });
    return { knowledgeVersionId: String(inserted._id), sourceVersionId: String(sourceVersionId) };
  }

  it('returns ready summary with the current knowledge version id', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Browse Ready', 'idem-browse-ready');
    const published = await publishReady({
      orgId: String(org._id),
      projectId: project.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/summary`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'ready',
      knowledgeVersionId: published.knowledgeVersionId,
    });
    expect(res.json().summary).toContain('Payments service.');

    const index = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(index.statusCode).toBe(200);
    expect(index.json().state).toBe('ready');

    const symbols = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/symbols?q=pa`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(symbols.statusCode).toBe(200);
    expect(symbols.json().items).toEqual([]);

    const apis = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/apis`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(apis.statusCode).toBe(200);

    const health = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/health`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().state).toBe('ready');
  });

  it('returns updating with empty items when knowledge is updating', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Browse Updating', 'idem-browse-upd');
    await Project.updateOne(
      { _id: project.id },
      {
        $set: {
          knowledgeHealth: 'updating',
          lifecycleStatus: 'updating',
          currentKnowledgeVersionId: new mongoose.Types.ObjectId(),
        },
      },
    );
    void org;

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/workflows`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'updating', items: [] });
  });

  it('returns unavailable when knowledge failed', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Browse Failed', 'idem-browse-fail');
    await Project.updateOne({ _id: project.id }, { $set: { knowledgeHealth: 'failed', lifecycleStatus: 'failed' } });

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('unavailable');
    expect(res.json().facets).toEqual([]);
  });

  it('includes exclusion count for partially_available health', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Browse Partial', 'idem-browse-part');
    await publishReady({
      orgId: String(org._id),
      projectId: project.id,
      health: 'partially_available',
      excludedFileCount: 4,
    });

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/health`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'ready',
      knowledgeHealth: 'partially_available',
      partialKnowledge: { excludedFromGraphCount: 4 },
    });
  });

  it('returns 404 for a missing or soft-deleted project', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const missing = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${new mongoose.Types.ObjectId()}/knowledge/summary`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(missing.statusCode).toBe(404);

    const project = await createProject(app, accessToken, 'Browse Deleted', 'idem-browse-del');
    await softDeleteProject(String(org._id), project.id, { updatedBy: null });
    const deleted = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/summary`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleted.statusCode).toBe(404);
  });

  it('returns 400 when the symbol query is too short', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Browse Q', 'idem-browse-q');
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/symbols?q=x`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');

    const badLimit = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/workflows?limit=nope`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(badLimit.statusCode).toBe(400);

    const badApis = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/apis?limit=nope`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(badApis.statusCode).toBe(400);

    const badIndex = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge?limit=nope`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(badIndex.statusCode).toBe(400);
  });

  it('returns 403 when the caller lacks browse and view', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken: adminToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, adminToken, 'Browse Forbidden', 'idem-browse-403');
    const role = await createRoleInRepo(org._id, {
      name: 'No knowledge',
      permissions: ['org.view', 'projects.view'],
      createdBy: null,
    });
    const passwordHash = await hashPassword('NoKnowPass1!');
    const user = await createUserInRepo(org._id, {
      email: 'noknow@example.com',
      displayName: 'No Know',
      passwordHash,
      userStatus: 'active',
      createdBy: null,
      roleIds: [role._id],
    });
    await addProjectMember({
      orgId: String(org._id),
      projectId: project.id,
      userId: String(user._id),
      actorUserId: String(user._id),
      roleId: String(role._id),
      correlationId: 'corr-browse-403',
      log: createMockLog(),
    });
    const { accessToken } = await login(app, 'noknow@example.com', 'NoKnowPass1!');
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/knowledge/summary`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
