/**
 * Identity admin routes integration tests via app.inject.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import { AUTH_MODELS } from '../../../src/modules/access/auth.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { IDEMPOTENCY_MODELS, IdempotencyRecord } from '../../../src/platform/idempotency/index.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  createMembership,
  createOrganization,
  createUser, createUserInRepo,
  ensureBuiltInRoles,
  findBuiltInRole,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { containsForbiddenSecretKey } from '../../../src/modules/masters/users.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS, ...IDEMPOTENCY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('identity.routes', () => {
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

  it('returns 401 without a token and 403 without users.manage', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const passwordHash = await hashPassword('memberpass1');
    const member = await createUserInRepo(org._id, {
      email: 'member@example.com',
      displayName: 'Member',
      userStatus: 'active',
      passwordHash,
    });
    await createMembership(org._id, {
      userId: member._id,
      roleIds: [memberRole._id],
    });

    app = await readyApp();
    const unauth = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users`,
    });
    expect(unauth.statusCode).toBe(401);

    const { accessToken } = await login(app, 'member@example.com', 'memberpass1');
    const forbidden = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const denied = await listAuditEvents(org._id, { action: 'authz.denied' });
    expect(denied.items.length).toBeGreaterThan(0);
  });

  it('create → list → activate → remove lifecycle with audit and no secrets', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');

    const create = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'create-user-lifecycle-1',
      },
      payload: {
        email: 'ada@acme.example',
        displayName: 'Ada Lovelace',
        roleIds: [String(memberRole._id)],
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.userStatus).toBe('invited');
    expect(containsForbiddenSecretKey(created)).toBe(false);

    const listed = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?userStatus=invited`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.some((u) => u.id === created.id)).toBe(true);

    const activate = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${created.id}/activate`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().userStatus).toBe('active');

    const remove = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/users/${created.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(remove.statusCode).toBe(204);

    const afterRemove = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(afterRemove.json().items.some((u) => u.id === created.id)).toBe(false);

    const creates = await listAuditEvents(org._id, { action: 'user.create' });
    expect(creates.items.some((e) => e.resourceId === created.id)).toBe(true);
    const removes = await listAuditEvents(org._id, { action: 'user.remove' });
    expect(removes.items.some((e) => e.resourceId === created.id)).toBe(true);
  });

  it('cross-organization access returns 404 not 403', async () => {
    await runBootstrapSeed(createMockLog());
    const other = await createOrganization({ name: 'Other', slug: 'other-org' });
    await ensureBuiltInRoles(other._id);
    const otherUser = await createUserInRepo(other._id, {
      email: 'other@example.com',
      displayName: 'Other',
      userStatus: 'active',
    });

    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users/${otherUser._id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('keyset pagination across pages has no duplicates', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    for (let i = 0; i < 5; i += 1) {
      await createUserInRepo(org._id, {
        email: `page${i}@example.com`,
        displayName: `Page${i}`,
        userStatus: 'active',
      });
    }
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const page1 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?limit=2`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.pageInfo.hasMore).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?limit=2&cursor=${encodeURIComponent(body1.pageInfo.nextCursor)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body2 = page2.json();
    const ids = [...body1.items, ...body2.items].map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);

    const badLimit = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?limit=0`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(badLimit.statusCode).toBe(400);

    const clamped = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?limit=500`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json().items.length).toBeLessThanOrEqual(100);
  });

  it('rejects unknown query parameters on user list', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?unknown=1`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH email revokes sessions and role create/update/delete work', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const passwordHash = await hashPassword('targetpass1');
    const target = await createUserInRepo(org._id, {
      email: 'target@example.com',
      displayName: 'Target',
      userStatus: 'active',
      passwordHash,
    });
    await createMembership(org._id, {
      userId: target._id,
      roleIds: [memberRole._id],
    });

    app = await readyApp();
    const targetLogin = await login(app, 'target@example.com', 'targetpass1');
    const admin = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);

    const patch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/users/${target._id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { email: 'renamed@example.com' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().email).toBe('renamed@example.com');

    const me = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${targetLogin.accessToken}` },
    });
    expect(me.statusCode).toBe(401);

    const createRole = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/roles`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        name: 'Analyst',
        description: 'Custom',
        permissions: ['org.view', 'chat.ask'],
      },
    });
    expect(createRole.statusCode).toBe(201);
    const roleId = createRole.json().id;

    const patchBuiltIn = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/roles/${memberRole._id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { description: 'Updated member description' },
    });
    expect(patchBuiltIn.statusCode).toBe(200);
    expect(patchBuiltIn.json().description).toBe('Updated member description');

    const patchBuiltInPerms = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/roles/${memberRole._id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { permissions: ['org.view'] },
    });
    expect(patchBuiltInPerms.statusCode).toBe(409);
    expect(patchBuiltInPerms.json().error.code).toBe('BUILT_IN_ROLE_IMMUTABLE');

    const delRole = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/roles/${roleId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(delRole.statusCode).toBe(204);
  });

  it('self-deactivate fails and last admin cannot be deactivated', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken, user } = await login(
      app,
      DEFAULT_ADMIN_EMAIL,
      DEFAULT_ADMIN_PASSWORD,
    );
    const self = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${user.id}/deactivate`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('CANNOT_MODIFY_SELF');
  });

  it('creating a user with a foreign roleId returns 404', async () => {
    await runBootstrapSeed(createMockLog());
    const other = await createOrganization({ name: 'Foreign', slug: 'foreign-org' });
    const { roles } = await ensureBuiltInRoles(other._id);
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'create-user-foreign-role-1',
      },
      payload: {
        email: 'x@example.com',
        displayName: 'X',
        roleIds: [String(roles[0]._id)],
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires Idempotency-Key on POST /users', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        email: 'needs-key@example.com',
        displayName: 'Needs Key',
        roleIds: [String(memberRole._id)],
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays POST /users for the same Idempotency-Key and body', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const payload = {
      email: 'idempotent@example.com',
      displayName: 'Idempotent',
      roleIds: [String(memberRole._id)],
    };
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': 'create-user-replay-1',
    };

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users`,
      headers,
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(firstBody);

    const listed = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?q=idempotent@example.com`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
  });

  it('rejects Idempotency-Key reuse with a different body', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': 'create-user-reuse-1',
    };

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users`,
      headers,
      payload: {
        email: 'reuse-a@example.com',
        displayName: 'Reuse A',
        roleIds: [String(memberRole._id)],
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users`,
      headers,
      payload: {
        email: 'reuse-b@example.com',
        displayName: 'Reuse B',
        roleIds: [String(memberRole._id)],
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('concurrent POST /users with the same key create one user', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const payload = {
      email: 'concurrent@example.com',
      displayName: 'Concurrent',
      roleIds: [String(memberRole._id)],
    };
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': 'create-user-concurrent-1',
    };

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/users`,
        headers,
        payload,
      }),
      app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/users`,
        headers,
        payload,
      }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 201]);
    expect(a.json().id).toBe(b.json().id);

    const listed = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/users?q=concurrent@example.com`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listed.json().items).toHaveLength(1);
    expect(await IdempotencyRecord.countDocuments({})).toBe(1);
  });

  it('reset-password response and logs contain no secret', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await (
      await import('../../../src/modules/masters/organizations.js')
    ).findOrganizationBySlug('default');
    const memberRole = await findBuiltInRole(org._id, 'member');
    const target = await createUserInRepo(org._id, {
      email: 'resetme@example.com',
      displayName: 'Reset',
      userStatus: 'invited',
    });
    await createMembership(org._id, {
      userId: target._id,
      roleIds: [memberRole._id],
    });

    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const secret = 'brand-new-secret-99';
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/users/${target._id}/reset-password`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newPassword: secret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().passwordResetStatus).toBe('completed');
    expect(JSON.stringify(res.json())).not.toContain(secret);
    expect(containsForbiddenSecretKey(res.json())).toBe(false);
  });
});
