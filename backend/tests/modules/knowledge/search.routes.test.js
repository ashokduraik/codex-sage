/**
 * Knowledge search route integration tests.
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
  createUser, createUserInRepo,
  findOrganizationBySlug,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { PROJECT_MODELS } from '../../../src/modules/masters/projects.js';
import { Project } from '../../../src/models/projects.model.js';
import { addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { DOCUMENT_MODELS, insertDocumentSections } from '../../../src/modules/knowledge/documents.js';
import { KNOWLEDGE_MODELS, insertKnowledgeVersion } from '../../../src/modules/knowledge/knowledge.js';

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...AUTH_MODELS,
    ...AUDIT_MODELS,
    ...IDEMPOTENCY_MODELS,
    ...PROJECT_MODELS,
    ...KNOWLEDGE_MODELS,
    ...DOCUMENT_MODELS,
  ],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('search routes', () => {
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
   * Marks a project ready with a published knowledge version and a doc section.
   * @param {{ orgId: string, projectId: string }} input Scope.
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
        skippedFileCount: 0,
        mode: 'indexAll',
        graphDir: '.codegraph',
      },
      publishedHealth: 'ready',
      excludedFileCount: 0,
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
    await insertDocumentSections({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      path: 'docs/refunds.md',
      sections: [
        {
          heading: 'Refund policy',
          startLine: 1,
          endLine: 4,
          text: 'Partial refunds are allowed within thirty days.',
          sectionIndex: 0,
        },
      ],
    });
    return { knowledgeVersionId: String(inserted._id), sourceVersionId: String(sourceVersionId) };
  }

  it('returns document hits for a ready project', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Search Ready', 'idem-search-ready');
    const published = await publishReady({
      orgId: String(org._id),
      projectId: project.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/search?q=refunds&types=doc`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ready');
    expect(body.knowledgeVersionId).toBe(published.knowledgeVersionId);
    expect(body.items.some((item) => item.type === 'doc')).toBe(true);
    expect(body.items[0].id.startsWith(`${published.knowledgeVersionId}:doc:`)).toBe(true);
  });

  it('returns updating with empty items when knowledge is updating', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Search Updating', 'idem-search-upd');
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

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/search?q=ab&types=doc`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'updating', items: [] });
  });

  it('returns 400 for a short query or unknown type', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Search Valid', 'idem-search-val');

    const shortQ = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/search?q=x`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(shortQ.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/search?q=ab&types=data`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a missing project', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${new mongoose.Types.ObjectId()}/search?q=ab`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when the caller lacks search.run', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken: adminToken } = await login(
      app,
      DEFAULT_ADMIN_EMAIL,
      DEFAULT_ADMIN_PASSWORD,
    );
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, adminToken, 'Search Forbidden', 'idem-search-403');
    const role = await createRoleInRepo(org._id, {
      name: 'No search',
      permissions: ['org.view', 'projects.view'],
      createdBy: null,
    });
    const passwordHash = await hashPassword('NoSearchPass1!');
    const user = await createUserInRepo(org._id, {
      email: 'nosearch@example.com',
      displayName: 'No Search',
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
      correlationId: 'corr-search-403',
      log: createMockLog(),
    });
    const { accessToken } = await login(app, 'nosearch@example.com', 'NoSearchPass1!');
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/search?q=ab`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
