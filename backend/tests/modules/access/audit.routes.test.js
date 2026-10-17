/**
 * Audit HTTP integration tests (list, detail, tenant isolation, retro-fits).
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { ROW_STATUS_DELETED } from '../../../src/platform/data/index.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_LIST_PAGE_SIZE_MAX } from '../../../src/modules/access/audit.js';
import { createTestOrganization, ensureTestRoles, nextTestUserCode } from '../../identityFixtures.js';
import { AUDIT_MODELS, AuditEvent, insertAuditEvent, listAuditEvents } from '../../../src/modules/access/audit.js';
import {
  IDENTITY_MODELS,
  createUserInRepo,
  DEFAULT_ORG_SLUG,
  runBootstrapSeed,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  findOrganizationBySlug,
} from '../../../src/modules/masters/index.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function, warn: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
}

describe('audit routes', () => {
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
      url: `${API_BASE_PATH}/access/auth/login`,
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken;
  }

  it('returns 401 without a token and 403 without audit.view', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const { roles } = await ensureTestRoles(org._id);
    const viewer = roles.find((role) => role.code === 'VIEWER');
    const password = 'viewer-pass-audit-1';
    const user = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: `viewer-audit-${Date.now()}@example.com`,
      displayName: 'Viewer',
      userStatus: 'active',
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
      roleIds: [viewer._id],
    });

    app = await readyApp();
    const unauth = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list`,
    });
    expect(unauth.statusCode).toBe(401);

    const token = await login(app, user.email, password);
    const forbidden = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('scopes list to the caller org and supports filters + keyset pagination', async () => {
    await runBootstrapSeed(createMockLog());
    const orgA = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const orgB = await createTestOrganization({
      name: 'Other Org',
      slug: `other-audit-${Date.now()}`,
    });
    const { roles: rolesB } = await ensureTestRoles(orgB._id);
    const adminB = rolesB.find((role) => role.code === 'ADMIN');
    const passwordB = 'other-admin-pass-1';
    const userB = await createUserInRepo(orgB._id, {
      code: nextTestUserCode(),
      email: `admin-b-${Date.now()}@example.com`,
      displayName: 'Admin B',
      userStatus: 'active',
      passwordHash: await hashPassword(passwordB),
      passwordUpdatedAt: new Date(),
      roleIds: [adminB._id],
    });

    const actorA = new mongoose.Types.ObjectId();
    for (let i = 0; i < 3; i += 1) {
      await insertAuditEvent({
        orgId: orgA._id,
        actorUserId: actorA,
        action: 'user.password_changed',
        resourceType: 'user',
        result: 'success',
        correlationId: `REQ-a-${i}`,
      });
    }
    await insertAuditEvent({
      orgId: orgA._id,
      actorUserId: actorA,
      action: 'authz.denied',
      resourceType: 'route',
      result: 'denied',
      correlationId: 'REQ-a-denied',
    });
    await insertAuditEvent({
      orgId: orgB._id,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-b-1',
    });

    app = await readyApp();
    const tokenA = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const listA = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?limit=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listA.statusCode).toBe(200);
    const bodyA = listA.json();
    expect(bodyA.items).toHaveLength(2);
    expect(bodyA.pageInfo.hasMore).toBe(true);
    expect(bodyA.items.every((item) => item.correlationId.startsWith('REQ-a'))).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?limit=2&cursor=${encodeURIComponent(bodyA.pageInfo.nextCursor)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    const allIds = [...bodyA.items, ...body2.items].map((item) => item.id);
    expect(new Set(allIds).size).toBe(allIds.length);

    const rangeFrom = new Date();
    rangeFrom.setUTCDate(rangeFrom.getUTCDate() - 15);
    const rangeTo = new Date();
    rangeTo.setUTCDate(rangeTo.getUTCDate() + 1);
    const filtered = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?action=authz.denied&resourceType=route&actor=${actorA.toHexString()}&from=${encodeURIComponent(rangeFrom.toISOString())}&to=${encodeURIComponent(rangeTo.toISOString())}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0].result).toBe('denied');

    const clamped = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?limit=${AUDIT_LIST_PAGE_SIZE_MAX + 50}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json().items.length).toBeLessThanOrEqual(AUDIT_LIST_PAGE_SIZE_MAX);

    const tokenB = await login(app, userB.email, passwordB);
    const listB = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().items).toHaveLength(1);
    expect(listB.json().items[0].correlationId).toBe('REQ-b-1');
  });

  it('rejects a from/to window longer than 31 days', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const tokenA = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const rejected = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?from=2026-09-01T00:00:00.000Z&to=2026-10-03T00:00:00.000Z`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns detail for same org and 404 for cross-tenant ids', async () => {
    await runBootstrapSeed(createMockLog());
    const orgA = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const orgB = await createTestOrganization({
      name: 'Detail Org',
      slug: `detail-audit-${Date.now()}`,
    });
    const eventA = await insertAuditEvent({
      orgId: orgA._id,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-detail-a',
    });
    const eventB = await insertAuditEvent({
      orgId: orgB._id,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-detail-b',
    });

    app = await readyApp();
    const token = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const ok = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/get/${eventA._id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().correlationId).toBe('REQ-detail-a');

    const cross = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/get/${eventB._id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cross.statusCode).toBe(404);
  });

  it('hides soft-deleted audit rows and rejects unknown query keys', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const doc = await insertAuditEvent({
      orgId: org._id,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-soft-delete',
    });
    await AuditEvent.updateOne({ _id: doc._id }, { $set: { status: ROW_STATUS_DELETED } }, { retentionJob: true });

    app = await readyApp();
    const token = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const list = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.find((item) => item.id === String(doc._id))).toBeUndefined();

    const badQuery = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?orgId=nope`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badQuery.statusCode).toBe(400);

    const badAction = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?action=user.invented`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badAction.statusCode).toBe(400);

    const badActor = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?actor=not-an-object-id`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badActor.statusCode).toBe(400);

    const badFrom = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?from=not-a-date`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badFrom.statusCode).toBe(400);
  });

  it('rejects malformed detail params', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const token = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const missing = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/get/${new mongoose.Types.ObjectId()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('writes a password change audit row with the request correlation id', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const token = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const change = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/access/password/change`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        currentPassword: DEFAULT_ADMIN_PASSWORD,
        newPassword: 'Changed-pass-audit-99',
      },
    });
    expect(change.statusCode).toBe(200);
    const correlationId = change.headers['x-correlation-id'];
    expect(correlationId).toBeTruthy();

    const relogin = await login(app, DEFAULT_ADMIN_EMAIL, 'Changed-pass-audit-99');
    const list = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?action=user.password_changed`,
      headers: { authorization: `Bearer ${relogin}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].correlationId).toBe(correlationId);
    expect(items[0].result).toBe('success');
    const blob = JSON.stringify(items);
    expect(blob.toLowerCase()).not.toContain('passwordhash');
    expect(blob).not.toContain(DEFAULT_ADMIN_PASSWORD);
    expect(blob).not.toContain('Changed-pass-audit-99');
  });

  it('audits admin/security 403 denials but not projects.view denials', async () => {
    await runBootstrapSeed(createMockLog());
    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const { roles } = await ensureTestRoles(org._id);
    const viewer = roles.find((role) => role.code === 'VIEWER');
    const password = 'viewer-deny-audit-1';
    const user = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: `viewer-deny-${Date.now()}@example.com`,
      displayName: 'Viewer Deny',
      userStatus: 'active',
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
      roleIds: [viewer._id],
    });

    app = await readyApp();
    const token = await login(app, user.email, password);

    const adminDenied = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/permissions/list`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(adminDenied.statusCode).toBe(403);

    const auditDenied = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(auditDenied.statusCode).toBe(403);

    const adminToken = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const list = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/access/audit/list?action=authz.denied`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((item) => item.result === 'denied')).toBe(true);
    expect(
      items.some((item) => (Array.isArray(item.context?.requiredPermissions) ? item.context.requiredPermissions.includes('roles.manage') : false)),
    ).toBe(true);
    expect(
      items.some((item) => (Array.isArray(item.context?.requiredPermissions) ? item.context.requiredPermissions.includes('audit.view') : false)),
    ).toBe(true);

    // Non-admin permission class is not present in the seeded catalog routes yet;
    // assert repository still only contains authz.denied for admin/security keys.
    const orgEvents = await listAuditEvents(org._id, { action: 'authz.denied' });
    for (const doc of orgEvents.items) {
      const required = doc.context?.requiredPermissions ?? [];
      expect(required.some((key) => ['users.manage', 'roles.manage', 'settings.manage', 'audit.view'].includes(key))).toBe(true);
    }
  });
});
