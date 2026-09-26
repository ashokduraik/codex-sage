/**
 * Password change and admin-set integration tests via app.inject.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  createOrganization,
  createUserInRepo,
  findBuiltInRole,
  findUserById,
  findUserByIdWithPassword,
  runBootstrapSeed,
  softDeleteUser,
} from '../../../src/modules/masters/index.js';
import { LoginSession } from '../../../src/models/loginSession.model.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import mongoose from 'mongoose';

const PLACEHOLDER_ROLE_ID = new mongoose.Types.ObjectId();

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function, lines: string[] }}
 */
function createCapturingLog() {
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {unknown} obj
   * @param {string} [msg]
   */
  function capture(obj, msg) {
    lines.push(`${msg ?? ''} ${JSON.stringify(obj)}`);
  }
  return {
    lines,
    info: capture,
    debug: capture,
    error: capture,
    child() {
      return this;
    },
  };
}

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('password.routes and adminPasswordReset.routes', () => {
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

  it('self-change returns 200, revokes sessions, and rejects the old access token', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken, user } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const change = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/password/change`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        currentPassword: DEFAULT_ADMIN_PASSWORD,
        newPassword: 'newpass1',
      },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json()).toEqual({
      passwordChanged: true,
      sessionsRevoked: true,
      reauthenticationRequired: true,
    });
    expect(JSON.stringify(change.json())).not.toMatch(/newpass1/);

    const revoked = await LoginSession.find({ userId: user.id, revokedAt: { $ne: null } });
    expect(revoked.length).toBeGreaterThan(0);
    expect(revoked.every((row) => row.revokedReason === 'password_changed')).toBe(true);

    const me = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('SESSION_EXPIRED');

    const updated = await findUserById(user.orgId, user.id);
    expect(updated.mustChangePassword).toBe(false);
  });

  it('self-change with the wrong current password returns 403 and keeps sessions', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken, user } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const change = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/password/change`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        currentPassword: 'wrong-password',
        newPassword: 'newpass1',
      },
    });
    expect(change.statusCode).toBe(403);
    expect(change.json().error.code).toBe('INVALID_CURRENT_PASSWORD');

    const active = await LoginSession.find({
      userId: user.id,
      revokedAt: null,
      loggedOutAt: null,
    });
    expect(active.length).toBeGreaterThan(0);

    const me = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('self-change rejects SAME_AS_CURRENT with 422', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const change = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/password/change`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        currentPassword: DEFAULT_ADMIN_PASSWORD,
        newPassword: DEFAULT_ADMIN_PASSWORD,
      },
    });
    expect(change.statusCode).toBe(422);
    expect(change.json().error.code).toBe('PASSWORD_POLICY_VIOLATION');
    expect(change.json().error.details.violations).toContain('SAME_AS_CURRENT');
  });

  it('admin set-password completes, never echoes the secret, and activates invited users', async () => {
    const seed = await runBootstrapSeed(createMockLog());
    const orgId = seed.orgId;
    const memberRole = await findBuiltInRole(orgId, 'member');
    const invited = await createUserInRepo(orgId, {
      email: 'invited@example.com',
      displayName: 'Invited',
      userStatus: 'invited',
      roleIds: [memberRole._id],
    });

    app = await readyApp();
    const { accessToken, user: admin } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const reset = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${invited._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'temp-secret' },
    });
    expect(reset.statusCode).toBe(200);
    const body = reset.json();
    expect(body.userId).toBe(String(invited._id));
    expect(body.passwordResetStatus).toBe('completed');
    expect(body.sessionsRevoked).toBe(true);
    expect(body.deliveryChannel).toBe('administrator');
    expect(body).not.toHaveProperty('newPassword');
    expect(JSON.stringify(body)).not.toMatch(/temp-secret/);

    const target = await findUserByIdWithPassword(orgId, invited._id);
    expect(target.userStatus).toBe('active');
    expect(target.mustChangePassword).toBe(true);
    expect(target.passwordHash).toBeTruthy();

    const targetLogin = await login(app, 'invited@example.com', 'temp-secret');
    expect(targetLogin.user.mustChangePassword).toBe(true);

    const blocked = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${admin.id}/reset-password`,
      headers: { authorization: `Bearer ${targetLogin.accessToken}` },
      payload: { newPassword: 'another1' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(['PASSWORD_CHANGE_REQUIRED', 'FORBIDDEN']).toContain(blocked.json().error.code);

    const me = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${targetLogin.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);
  });

  it('admin set-password for another org returns 404', async () => {
    await runBootstrapSeed(createMockLog());
    const otherOrg = await createOrganization({
      name: 'Other',
      slug: 'other-org-pw',
    });
    const outsider = await createUserInRepo(otherOrg._id, {
      email: 'out@example.com',
      displayName: 'Out',
      userStatus: 'active',
      passwordHash: await hashPassword('outsider'),
      passwordUpdatedAt: new Date(),
      roleIds: [PLACEHOLDER_ROLE_ID],
    });

    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const reset = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${outsider._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'temp-secret' },
    });
    expect(reset.statusCode).toBe(404);
    expect(reset.json().error.code).toBe('NOT_FOUND');
  });

  it('admin set-password targeting the caller returns 409', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken, user } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const reset = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${user.id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'temp-secret' },
    });
    expect(reset.statusCode).toBe(409);
    expect(reset.json().error.code).toBe('CANNOT_MODIFY_SELF');
  });

  it('admin set-password without users.manage returns 403', async () => {
    const seed = await runBootstrapSeed(createMockLog());
    const orgId = seed.orgId;
    const memberRole = await findBuiltInRole(orgId, 'member');
    await createUserInRepo(orgId, {
      email: 'member@example.com',
      displayName: 'Member',
      userStatus: 'active',
      passwordHash: await hashPassword('member1'),
      passwordUpdatedAt: new Date(),
      roleIds: [memberRole._id],
    });
    const target = await createUserInRepo(orgId, {
      email: 'target@example.com',
      displayName: 'Target',
      userStatus: 'active',
      passwordHash: await hashPassword('target1'),
      passwordUpdatedAt: new Date(),
      roleIds: [PLACEHOLDER_ROLE_ID],
    });

    app = await readyApp();
    const { accessToken } = await login(app, 'member@example.com', 'member1');
    const reset = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${target._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'temp-secret' },
    });
    expect(reset.statusCode).toBe(403);
    expect(reset.json().error.code).toBe('FORBIDDEN');
  });

  it('admin set-password for soft-deleted user returns 404', async () => {
    const seed = await runBootstrapSeed(createMockLog());
    const orgId = seed.orgId;
    const gone = await createUserInRepo(orgId, {
      email: 'gone@example.com',
      displayName: 'Gone',
      userStatus: 'active',
      passwordHash: await hashPassword('gone123'),
      passwordUpdatedAt: new Date(),
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    await softDeleteUser(orgId, gone._id);

    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const reset = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${gone._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'temp-secret' },
    });
    expect(reset.statusCode).toBe(404);
  });

  it('rejects validation and TOO_SHORT on self-change', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/password/change`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('VALIDATION_ERROR');

    const short = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/password/change`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        currentPassword: DEFAULT_ADMIN_PASSWORD,
        newPassword: 'ab',
      },
    });
    expect(short.statusCode).toBe(422);
    expect(short.json().error.details.violations).toContain('TOO_SHORT');
  });

  it('rejects validation and TOO_SHORT on admin set-password', async () => {
    const seed = await runBootstrapSeed(createMockLog());
    const target = await createUserInRepo(seed.orgId, {
      email: 't@example.com',
      displayName: 'T',
      userStatus: 'active',
      passwordHash: await hashPassword('target1'),
      passwordUpdatedAt: new Date(),
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${target._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const short = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${target._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'ab' },
    });
    expect(short.statusCode).toBe(422);
    expect(short.json().error.details.violations).toContain('TOO_SHORT');
  });

  it('allows a custom role that lists users.manage', async () => {
    const seed = await runBootstrapSeed(createMockLog());
    const orgId = seed.orgId;
    const { Role } = await import('../../../src/models/role.model.js');
    const managerRole = await Role.create({
      orgId,
      name: 'User Managers',
      isBuiltIn: false,
      permissions: ['users.manage'],
    });
    await createUserInRepo(orgId, {
      email: 'mgr@example.com',
      displayName: 'Mgr',
      userStatus: 'active',
      passwordHash: await hashPassword('manager1'),
      passwordUpdatedAt: new Date(),
      roleIds: [managerRole._id],
    });
    const target = await createUserInRepo(orgId, {
      email: 'tgt@example.com',
      displayName: 'Tgt',
      userStatus: 'active',
      passwordHash: await hashPassword('target1'),
      passwordUpdatedAt: new Date(),
      roleIds: [PLACEHOLDER_ROLE_ID],
    });

    app = await readyApp();
    const { accessToken } = await login(app, 'mgr@example.com', 'manager1');
    const reset = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${target._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'fresh12' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().passwordResetStatus).toBe('completed');
  });

  it('admin set rejects SAME_AS_CURRENT against the target hash', async () => {
    const seed = await runBootstrapSeed(createMockLog());
    const orgId = seed.orgId;
    const target = await createUserInRepo(orgId, {
      email: 'same@example.com',
      displayName: 'Same',
      userStatus: 'active',
      passwordHash: await hashPassword('sameold'),
      passwordUpdatedAt: new Date(),
      roleIds: [PLACEHOLDER_ROLE_ID],
    });
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const reset = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${target._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: 'sameold' },
    });
    expect(reset.statusCode).toBe(422);
    expect(reset.json().error.details.violations).toContain('SAME_AS_CURRENT');
  });

  it('does not log plaintext passwords on password change', async () => {
    await runBootstrapSeed(createMockLog());
    const capturing = createCapturingLog();
    app = buildApp(TEST_APP_CONFIG);
    app.log = capturing;
    await app.ready();

    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/password/change`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        currentPassword: DEFAULT_ADMIN_PASSWORD,
        newPassword: 'unique-secret-xyz',
      },
    });

    const joined = capturing.lines.join('\n');
    expect(joined).not.toContain('unique-secret-xyz');
    expect(joined).not.toContain(DEFAULT_ADMIN_PASSWORD);
  });
});
