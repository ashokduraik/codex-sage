/**
 * Conversation route integration tests — owner privacy, lifecycle, search, titles.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  createRoleInRepo,
  createUser, createUserInRepo,
  findBuiltInRole,
  findOrganizationBySlug,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { PROJECT_MODELS, Project } from '../../../src/modules/masters/projects.js';
import { addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { CONVERSATION_MODELS, Message, refreshConversationSearchText } from '../../../src/modules/conversation/conversation.js';
import { CONVERSATION_DEFAULT_TITLE } from '../../../src/modules/conversation/conversation.helper.js';

const harness = createMongoHarness({
  models: [
    ...IDENTITY_MODELS,
    ...AUTH_MODELS,
    ...AUDIT_MODELS,
    ...IDEMPOTENCY_MODELS,
    ...PROJECT_MODELS,
    ...CONVERSATION_MODELS,
  ],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('conversation routes', () => {
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
   * @param {import('fastify').FastifyInstance} instance App.
   * @param {string} accessToken Token.
   * @param {string} projectId Project id.
   * @param {object} payload Body.
   * @param {string} idempotencyKey Idempotency key.
   */
  async function createConversation(instance, accessToken, projectId, payload, idempotencyKey) {
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${accessToken}` };
    if (idempotencyKey) {
      headers['idempotency-key'] = idempotencyKey;
    }
    return instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${projectId}/conversations`,
      headers,
      payload,
    });
  }

  it('creates with Idempotency-Key, default title, and increments project count', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Chat Count', 'idem-conv-proj-1');

    const missingKey = await createConversation(app, accessToken, project.id, {}, undefined);
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const first = await createConversation(
      app,
      accessToken,
      project.id,
      {},
      'idem-conv-create-1',
    );
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.title).toBe(CONVERSATION_DEFAULT_TITLE);
    expect(body.titleSource).toBe('default');
    expect(body.messageCount).toBe(0);
    expect(body.lastMessageAt).toBeNull();

    const replay = await createConversation(
      app,
      accessToken,
      project.id,
      {},
      'idem-conv-create-1',
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(body.id);

    const named = await createConversation(
      app,
      accessToken,
      project.id,
      { title: 'Checkout flow' },
      'idem-conv-create-2',
    );
    expect(named.statusCode).toBe(201);
    expect(named.json().title).toBe('Checkout flow');
    expect(named.json().titleSource).toBe('user');

    const projectRow = await Project.findById(project.id);
    expect(projectRow.counts.conversations).toBe(2);

    const audits = await listAuditEvents(org._id, { action: 'conversation.created' });
    expect(audits.items.length).toBeGreaterThanOrEqual(2);
    for (const event of audits.items) {
      expect(event.context.content).toBeUndefined();
      expect(typeof event.context.titleLength).toBe('number');
    }
  });

  it('lists, archives, restores, deletes, and hides deleted messages', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Chat Life', 'idem-conv-proj-life');
    const created = await createConversation(
      app,
      accessToken,
      project.id,
      { title: 'Keep history' },
      'idem-conv-life-1',
    );
    const conversationId = created.json().id;

    await Message.create({
      orgId: org._id,
      projectId: project.id,
      conversationId,
      role: 'user',
      content: 'How does checkout work?',
      messageStatus: 'completed',
    });

    const listActive = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listActive.statusCode).toBe(200);
    expect(listActive.json().items.map((item) => item.id)).toContain(conversationId);

    const archive = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/archive`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().lifecycleStatus).toBe('archived');

    const archiveAgain = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/archive`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(archiveAgain.statusCode).toBe(409);
    expect(archiveAgain.json().error.code).toBe('INVALID_STATE_TRANSITION');

    const listAfterArchive = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listAfterArchive.json().items.map((item) => item.id)).not.toContain(conversationId);

    const listArchived = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations?archived=true`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listArchived.json().items.map((item) => item.id)).toContain(conversationId);

    const restore = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/restore`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().lifecycleStatus).toBe('active');

    const restoreAgain = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/restore`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(restoreAgain.statusCode).toBe(409);

    const messages = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().items[0].content).toBe('How does checkout work?');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const getDeleted = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getDeleted.statusCode).toBe(404);
    expect(getDeleted.json().error.code).toBe('CONVERSATION_NOT_FOUND');

    const messagesAfter = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(messagesAfter.statusCode).toBe(404);

    const projectRow = await Project.findById(project.id);
    expect(projectRow.counts.conversations).toBe(0);

    const deleteAudits = await listAuditEvents(org._id, { action: 'conversation.deleted' });
    expect(deleteAudits.items.length).toBeGreaterThanOrEqual(1);
    expect(deleteAudits.items[0].context.content).toBeUndefined();
  });

  it('keeps conversations private from other users including org_admin', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const admin = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, admin.accessToken, 'Private Chat', 'idem-conv-priv');
    const created = await createConversation(
      app,
      admin.accessToken,
      project.id,
      { title: 'Admin private thread' },
      'idem-conv-priv-1',
    );
    const conversationId = created.json().id;

    const adminRole = await findBuiltInRole(org._id, 'org_admin');
    const passwordHash = await hashPassword('OtherAdmin1!');
    const otherAdmin = await createUserInRepo(org._id, {
      email: 'other-admin@example.com',
      displayName: 'Other Admin',
      userStatus: 'active',
      passwordHash,
          roleIds: [adminRole._id],
          projectAccessMode: 'all'
        });
    const other = await login(app, 'other-admin@example.com', 'OtherAdmin1!');

    const getDenied = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(getDenied.statusCode).toBe(404);
    expect(getDenied.json().error.code).toBe('CONVERSATION_NOT_FOUND');

    const listOther = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(listOther.json().items.map((item) => item.id)).not.toContain(conversationId);

    const searchOther = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=private`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(searchOther.statusCode).toBe(200);
    expect(searchOther.json().items).toEqual([]);

    const archiveDenied = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/archive`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(archiveDenied.statusCode).toBe(404);

    const renameDenied = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { title: 'Hijacked' },
    });
    expect(renameDenied.statusCode).toBe(404);
  });

  it('searches by title and message text, excludes archived, and accepts rename', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Chat Search', 'idem-conv-search');
    const created = await createConversation(
      app,
      accessToken,
      project.id,
      { title: 'Refund policy' },
      'idem-conv-search-1',
    );
    const conversationId = created.json().id;
    await Message.create({
      orgId: org._id,
      projectId: project.id,
      conversationId,
      role: 'user',
      content: 'card declines during checkout payment',
      messageStatus: 'completed',
    });
    await refreshConversationSearchText({
      orgId: org._id,
      projectId: project.id,
      conversationId,
    });

    const shortQ = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=a`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(shortQ.statusCode).toBe(400);

    const byTitle = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=Refund`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(byTitle.statusCode).toBe(200);
    expect(byTitle.json().items[0].id).toBe(conversationId);
    expect(byTitle.json().items[0].snippet).toBeTruthy();

    const byMessage = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=checkout`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(byMessage.statusCode).toBe(200);
    expect(byMessage.json().items.map((item) => item.id)).toContain(conversationId);

    const metaChars = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=${encodeURIComponent('checkout " ')}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(metaChars.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/archive`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const hidden = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=Refund`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(hidden.json().items).toEqual([]);
    const archivedSearch = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=Refund&archived=1`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(archivedSearch.json().items.map((item) => item.id)).toContain(conversationId);

    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}/restore`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const renamed = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { title: 'Payment failure investigation' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().titleSource).toBe('user');
    expect(renamed.json().title).toBe('Payment failure investigation');

    const emptyTitle = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { title: '   ' },
    });
    expect(emptyTitle.statusCode).toBe(400);

    const foundNew = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=Payment`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(foundNew.json().items.map((item) => item.id)).toContain(conversationId);

    const audits = await listAuditEvents(org._id, { action: 'conversation.title_changed' });
    expect(audits.items[0].context.oldTitleLength).toBeGreaterThan(0);
    expect(audits.items[0].context.title).toBeUndefined();
  });

  it('returns 403 without chat.ask, 404 for unknown project and cross-org ids', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const admin = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, admin.accessToken, 'Chat ACL', 'idem-conv-acl');
    const created = await createConversation(
      app,
      admin.accessToken,
      project.id,
      { title: 'Scoped' },
      'idem-conv-acl-1',
    );

    const role = await createRoleInRepo(org._id, {
      name: 'No chat',
      permissions: ['org.view', 'projects.view'],
      createdBy: null,
    });
    const passwordHash = await hashPassword('NoChatPass1!');
    const user = await createUserInRepo(org._id, {
      email: 'nochat@example.com',
      displayName: 'No Chat',
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
      correlationId: 'corr-conv-403',
      log: createMockLog(),
    });
    const denied = await login(app, 'nochat@example.com', 'NoChatPass1!');
    const listForbidden = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations`,
      headers: { authorization: `Bearer ${denied.accessToken}` },
    });
    expect(listForbidden.statusCode).toBe(403);

    const missingProject = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${new mongoose.Types.ObjectId()}/conversations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json().error.code).toBe('PROJECT_NOT_FOUND');

    const crossOrg = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${new mongoose.Types.ObjectId()}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(crossOrg.statusCode).toBe(404);
    expect(crossOrg.json().error.code).toBe('CONVERSATION_NOT_FOUND');
    expect(created.statusCode).toBe(201);

    const zeroLimit = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations?limit=0`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(zeroLimit.statusCode).toBe(400);

    const badCursor = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations?cursor=%%%`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(badCursor.statusCode).toBe(400);

    const badCreate = await createConversation(
      app,
      admin.accessToken,
      project.id,
      { title: '' },
      'idem-conv-acl-bad',
    );
    expect(badCreate.statusCode).toBe(400);

    const badList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations?limit=nope`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(badList.statusCode).toBe(400);

    const badSearch = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/search?q=ab&limit=nope`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(badSearch.statusCode).toBe(400);

    const badMessages = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${created.json().id}/messages?limit=nope`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(badMessages.statusCode).toBe(400);

    const extraPatch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}/conversations/${created.json().id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { title: 'Ok', extra: true },
    });
    expect(extraPatch.statusCode).toBe(400);
  });
});
