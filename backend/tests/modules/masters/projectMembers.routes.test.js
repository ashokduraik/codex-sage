/**
 * Project members API integration tests.
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
  createOrganization,
  createUser, createUserInRepo,
  ensureBuiltInRoles,
  findBuiltInRole,
  findOrganizationBySlug,
  findUserByEmail,
  runBootstrapSeed,
  updateUser,
} from '../../../src/modules/masters/index.js';
import { PROJECT_MODELS, createProjectInRepo } from '../../../src/modules/masters/projects.js';
import { findActiveProjectMember } from '../../../src/modules/masters/projectMembers.js';

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

describe('projectMembers.routes', () => {
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

  async function readyApp() {
    const instance = buildApp(TEST_APP_CONFIG);
    await instance.ready();
    return instance;
  }

  async function login(instance, email, password) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function createProject(instance, accessToken, name, key) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': key,
      },
      payload: { name, sourceType: 'upload' },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('adds, lists, removes members with audit and access changes', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, accessToken, 'Members Proj', 'idem-mem-proj-1');

    const passwordHash = await hashPassword('memberpass1');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const target = await createUserInRepo(org._id, {
      email: 'target-member@example.com',
      displayName: 'Target',
      userStatus: 'active',
      passwordHash,
          roleIds: [memberRole._id],
          projectAccessMode: 'selected'
        });

    const headers = { authorization: `Bearer ${accessToken}` };

    const deniedBefore = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}`,
      headers: {
        authorization: `Bearer ${(await login(app, 'target-member@example.com', 'memberpass1')).accessToken}`,
      },
    });
    expect(deniedBefore.statusCode).toBe(404);
    expect(deniedBefore.json().error.code).toBe('PROJECT_NOT_FOUND');

    const addRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers,
      payload: { userId: String(target._id), permissions: ['projects.view', 'chat.ask'] },
    });
    expect(addRes.statusCode).toBe(201);
    const memberBody = addRes.json();
    expect(memberBody.userId).toBe(String(target._id));
    expect(memberBody.permissions).toEqual(['projects.view', 'chat.ask']);

    const addAgain = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers,
      payload: { userId: String(target._id), permissions: ['projects.view'] },
    });
    expect(addAgain.statusCode).toBe(200);
    expect(addAgain.json().id).toBe(memberBody.id);

    const { accessToken: memberToken } = await login(
      app,
      'target-member@example.com',
      'memberpass1',
    );
    const allowed = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(allowed.statusCode).toBe(200);

    const listRes = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).not.toHaveProperty('nextCursor');
    expect(listRes.json().items.some((row) => row.userId === String(target._id))).toBe(true);

    const extraQuery = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/members?limit=10`,
      headers,
    });
    expect(extraQuery.statusCode).toBe(400);
    expect(extraQuery.json().error.code).toBe('VALIDATION_ERROR');

    const delRes = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/projects/${project.id}/members/${target._id}`,
      headers,
    });
    expect(delRes.statusCode).toBe(204);

    const deniedAfter = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(deniedAfter.statusCode).toBe(404);

    const delAgain = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/projects/${project.id}/members/${target._id}`,
      headers,
    });
    expect(delAgain.statusCode).toBe(404);
    expect(delAgain.json().error.code).toBe('MEMBER_NOT_FOUND');

    const reAdd = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers,
      payload: { userId: String(target._id), permissions: ['projects.view'] },
    });
    expect(reAdd.statusCode).toBe(201);
    expect(reAdd.json().id).toBe(memberBody.id);

    const addAudits = await listAuditEvents(org._id, { action: 'project.member_added' });
    expect(addAudits.items.length).toBeGreaterThanOrEqual(2);
    const removeAudits = await listAuditEvents(org._id, { action: 'project.member_removed' });
    expect(removeAudits.items.length).toBeGreaterThanOrEqual(1);
  });

  it('filters list by projectAccessMode and seeds creator membership', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const org = await findOrganizationBySlug('default');
    const { accessToken: adminToken } = await login(
      app,
      DEFAULT_ADMIN_EMAIL,
      DEFAULT_ADMIN_PASSWORD,
    );

    const passwordHash = await hashPassword('selpass12');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const selectedUser = await createUserInRepo(org._id, {
      email: 'selected@example.com',
      displayName: 'Selected',
      userStatus: 'active',
      passwordHash,
          roleIds: [memberRole._id],
          projectAccessMode: 'selected'
        });

    const noneUser = await createUserInRepo(org._id, {
      email: 'none@example.com',
      displayName: 'None',
      userStatus: 'active',
      passwordHash: await hashPassword('nonepass12'),
          roleIds: [memberRole._id],
          projectAccessMode: 'none'
        });

    const a = await createProject(app, adminToken, 'Project A', 'idem-list-a-1');
    const b = await createProject(app, adminToken, 'Project B', 'idem-list-b-1');

    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${a.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: String(selectedUser._id), permissions: ['projects.view'] },
    });

    const { accessToken: selectedToken } = await login(
      app,
      'selected@example.com',
      'selpass12',
    );
    const selectedList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?limit=20`,
      headers: { authorization: `Bearer ${selectedToken}` },
    });
    expect(selectedList.statusCode).toBe(200);
    const selectedIds = selectedList.json().items.map((row) => row.id);
    expect(selectedIds).toContain(a.id);
    expect(selectedIds).not.toContain(b.id);

    const { accessToken: noneToken } = await login(app, 'none@example.com', 'nonepass12');
    const noneList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?limit=20`,
      headers: { authorization: `Bearer ${noneToken}` },
    });
    expect(noneList.json().items).toHaveLength(0);

    const adminList = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects?limit=20`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminList.json().items.length).toBeGreaterThanOrEqual(2);

    const adminUser = await findUserByEmail(org._id, DEFAULT_ADMIN_EMAIL);
    const creator = await findActiveProjectMember(org._id, a.id, adminUser._id);
    expect(creator).toBeTruthy();
  });

  it('covers negative isolation matrix', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const org = await findOrganizationBySlug('default');
    const { accessToken: adminToken } = await login(
      app,
      DEFAULT_ADMIN_EMAIL,
      DEFAULT_ADMIN_PASSWORD,
    );
    const project = await createProject(app, adminToken, 'Iso', 'idem-iso-proj-1');

    const other = await createOrganization({
      name: 'Other Org',
      slug: `other-${Date.now()}`,
    });
    await ensureBuiltInRoles(other._id);
    const otherAdminRole = await findBuiltInRole(other._id, 'org_admin');
    const otherUser = await createUserInRepo(other._id, {
      email: 'other-admin@example.com',
      displayName: 'Other',
      userStatus: 'active',
      passwordHash: await hashPassword('otherpass1'),
          roleIds: [otherAdminRole._id],
          projectAccessMode: 'all'
        });

    const foreignProject = await createProjectInRepo(other._id, {
      name: 'Foreign',
      sourceType: 'upload',
      createdBy: otherUser._id,
    });
    const crossGet = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${foreignProject._id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(crossGet.statusCode).toBe(404);

    const crossAdd = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${foreignProject._id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: String(otherUser._id),
        permissions: ['projects.view'],
      },
    });
    expect(crossAdd.statusCode).toBe(404);

    const foreignUserAdd = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: String(otherUser._id),
        permissions: ['projects.view'],
      },
    });
    expect(foreignUserAdd.statusCode).toBe(404);
    expect(foreignUserAdd.json().error.code).toBe('USER_NOT_FOUND');

    const passwordHash = await hashPassword('viewpass12');
    const viewerRole = await findBuiltInRole(org._id, 'viewer');
    const viewer = await createUserInRepo(org._id, {
      email: 'viewer-acl@example.com',
      displayName: 'Viewer',
      userStatus: 'active',
      passwordHash,
          roleIds: [viewerRole._id],
          projectAccessMode: 'selected'
        });
    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: String(viewer._id),
        permissions: ['projects.view'],
      },
    });
    const { accessToken: viewerToken } = await login(
      app,
      'viewer-acl@example.com',
      'viewpass12',
    );
    const patchForbidden = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { name: 'Nope' },
    });
    expect(patchForbidden.statusCode).toBe(403);

    const noAccessUser = await createUserInRepo(org._id, {
      email: 'noaccess@example.com',
      displayName: 'NoAccess',
      userStatus: 'active',
      passwordHash: await hashPassword('nopass123'),
          roleIds: [viewerRole._id],
          projectAccessMode: 'selected'
        });
    const { accessToken: noAccessToken } = await login(
      app,
      'noaccess@example.com',
      'nopass123',
    );
    const noAccessGet = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}`,
      headers: { authorization: `Bearer ${noAccessToken}` },
    });
    expect(noAccessGet.statusCode).toBe(404);

    const badId = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/not-an-object-id`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(badId.statusCode).toBe(400);

    await updateUser(org._id, viewer._id, { projectAccessMode: 'selected' });
    await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/projects/${project.id}/members/${viewer._id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: String(viewer._id),
        permissions: ['projects.view', 'projects.update'],
      },
    });
    const { accessToken: elevatedToken } = await login(
      app,
      'viewer-acl@example.com',
      'viewpass12',
    );
    const elevatedPatch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}`,
      headers: { authorization: `Bearer ${elevatedToken}` },
      payload: { name: 'Elevated' },
    });
    expect(elevatedPatch.statusCode).toBe(200);
    expect(elevatedPatch.json().name).toBe('Elevated');

    const emptyOverlay = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: String(noAccessUser._id) },
    });
    expect(emptyOverlay.statusCode).toBe(400);

    const unknownRole = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: String(noAccessUser._id),
        roleId: new mongoose.Types.ObjectId().toHexString(),
      },
    });
    expect(unknownRole.statusCode).toBe(404);
    expect(unknownRole.json().error.code).toBe('ROLE_NOT_FOUND');

    const extraBodyKey = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: String(noAccessUser._id), permissions: ['projects.view'], extra: true },
    });
    expect(extraBodyKey.statusCode).toBe(400);
    expect(extraBodyKey.json().error.code).toBe('VALIDATION_ERROR');
  });
});
