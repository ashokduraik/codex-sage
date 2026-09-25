/**
 * Authorization HTTP integration tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { registerErrorHandler } from '../../../src/platform/errors.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { AUTH_MODELS } from '../../../src/modules/access/auth.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { createAuthenticatePreHandler } from '../../../src/modules/access/auth.js';
import { createAuthService } from '../../../src/modules/access/auth.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ORG_SLUG,
  IDENTITY_MODELS,
  createMembership,
  createUser, createUserInRepo,
  ensureBuiltInRoles,
  findOrganizationBySlug,
  findUserByEmail,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { Role } from '../../../src/models/role.model.js';
import { createAuthorizePreHandler } from '../../../src/modules/access/permissions.js';
import { ALL_PERMISSION_KEYS, PERMISSION_GROUPS } from '../../../src/modules/access/permissions.js';
import { invalidateRole } from '../../../src/modules/access/permissions.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('authorization routes', () => {
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
    return res.json().accessToken;
  }

  it('includes effective permissions on /auth/me for the bootstrap admin', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const token = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const me = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.permissions.sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
  });

  it('returns the full catalog for roles.manage and forbids viewers', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const { roles } = await ensureBuiltInRoles(org._id);
    const viewer = roles.find((role) => role.builtInKey === 'viewer');
    const password = 'viewer-pass-1';
    const user = await createUserInRepo(org._id, {
      email: `viewer-${Date.now()}@example.com`,
      displayName: 'Viewer',
      userStatus: 'active',
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
    });
    await createMembership(org._id, { userId: user._id, roleIds: [viewer._id] });

    app = await readyApp();
    const adminToken = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const allowed = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().groups).toHaveLength(PERMISSION_GROUPS.length);

    const viewerToken = await login(app, user.email, password);
    const denied = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/permissions`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    expect(denied.json().error.message).not.toMatch(/roles\.manage/);
  });

  it('forbids admin password reset without users.manage', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const role = await Role.create({
      orgId: org._id,
      name: `NoManage-${Date.now()}`,
      permissions: ['org.view'],
      isBuiltIn: false,
    });
    const password = 'member-pass-1';
    const user = await createUserInRepo(org._id, {
      email: `nomgr-${Date.now()}@example.com`,
      displayName: 'No Manage',
      userStatus: 'active',
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
    });
    await createMembership(org._id, { userId: user._id, roleIds: [role._id] });
    const admin = await findUserByEmail(org._id, DEFAULT_ADMIN_EMAIL);

    app = await readyApp();
    const token = await login(app, user.email, password);
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${admin._id}/reset-password`,
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: 'abcdef' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('returns 401 without an Authorization header on a guarded route', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/permissions`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 200 when the caller holds the permission, 403 otherwise, and supports any mode', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const role = await Role.create({
      orgId: org._id,
      name: `AskOnly-${Date.now()}`,
      permissions: ['chat.ask'],
      isBuiltIn: false,
    });
    const password = 'ask-pass-1';
    const user = await createUserInRepo(org._id, {
      email: `ask-${Date.now()}@example.com`,
      displayName: 'Asker',
      userStatus: 'active',
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
    });
    await createMembership(org._id, { userId: user._id, roleIds: [role._id] });

    const authService = createAuthService(TEST_APP_CONFIG.auth.jwtAccessTokenSecret);
    const loginResult = await authService.login(
      { email: user.email, password },
      { log: createMockLog() },
    );
    expect(loginResult.outcome).toBe('authenticated');

    app = Fastify({ genReqId: () => 'REQ-testauthorization000000000001' });
    app.decorateRequest('principal', null);
    registerErrorHandler(app);
    const authenticate = createAuthenticatePreHandler(authService);
    app.addHook('preHandler', createAuthorizePreHandler(authenticate));
    app.get(
      '/guarded',
      { config: { requiredPermissions: ['chat.ask'] } },
      async () => ({ ok: true }),
    );
    app.get(
      '/admin-only',
      { config: { requiredPermissions: ['roles.manage'] } },
      async () => ({ ok: true }),
    );
    app.get(
      '/any-guard',
      {
        config: {
          requiredPermissions: ['roles.manage', 'chat.ask'],
          permissionMode: 'any',
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();

    const headers = { authorization: `Bearer ${loginResult.accessToken}` };
    expect((await app.inject({ method: 'GET', url: '/guarded', headers })).statusCode).toBe(
      200,
    );
    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin-only',
      headers,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.message).not.toMatch(/roles\.manage/);
    expect(
      (await app.inject({ method: 'GET', url: '/any-guard', headers })).statusCode,
    ).toBe(200);

    await Role.updateOne({ _id: role._id }, { $set: { permissions: [] } });
    invalidateRole(String(org._id), String(role._id));
    expect((await app.inject({ method: 'GET', url: '/guarded', headers })).statusCode).toBe(
      403,
    );
  });
});
