/**
 * Organization retention policy resolve/update and HTTP surface.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_MODELS, AuditEvent } from '../../../src/modules/access/audit.js';
import { createTestOrganization, ensureTestRoles, nextTestUserCode } from '../../identityFixtures.js';
import {
  IDENTITY_MODELS,
  createUserInRepo,
  getRetentionPolicy,
  updateRetentionPolicy,
  RETENTION_POLICY_DEFAULTS,
  resolveEffectiveRetentionPolicy,
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

describe('organization retention policy', () => {
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

  it('merges missing fields with §12.3 defaults', () => {
    expect(resolveEffectiveRetentionPolicy(null)).toEqual(RETENTION_POLICY_DEFAULTS);
    expect(resolveEffectiveRetentionPolicy({ jobDays: 90 }).jobDays).toBe(90);
    expect(resolveEffectiveRetentionPolicy({ jobDays: 90 }).auditDays).toBe(RETENTION_POLICY_DEFAULTS.auditDays);
  });

  it('updates policy, audits the change, and rejects out-of-bounds values', async () => {
    const org = await createTestOrganization({
      name: 'Retain Policy Co',
      slug: `retain-policy-${new mongoose.Types.ObjectId().toHexString().slice(0, 8)}`,
    });
    const orgId = String(org._id);
    const before = await getRetentionPolicy(orgId);
    expect(before.readySourceVersionsKeep).toBe(3);

    const actorUserId = new mongoose.Types.ObjectId().toHexString();
    const updated = await updateRetentionPolicy({
      orgId,
      actorUserId,
      patch: { jobDays: 200, readySourceVersionsKeep: 5 },
      correlationId: 'corr-retention',
      log: createMockLog(),
    });
    expect(updated.jobDays).toBe(200);
    expect(updated.readySourceVersionsKeep).toBe(5);

    const audit = await AuditEvent.findOne({ orgId, action: 'retention.policy_changed' }).lean().exec();
    expect(audit).toBeTruthy();
    expect(audit.context.next_jobDays).toBe(200);
    expect(audit.context.previous_jobDays).toBe(180);

    await expect(
      updateRetentionPolicy({
        orgId,
        actorUserId,
        patch: { jobDays: 99999 },
        correlationId: 'corr-bad',
        log: createMockLog(),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('GET/PATCH retention policy require org.manage', async () => {
    const org = await createTestOrganization({
      name: 'Retain Http Co',
      slug: `retain-http-${new mongoose.Types.ObjectId().toHexString().slice(0, 8)}`,
    });
    const { admin, member } = await ensureTestRoles(org._id);
    const passwordHash = await hashPassword('Retention1!');
    const manager = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: `ret-mgr-${org._id}@example.com`,
      displayName: 'Retention Manager',
      userStatus: 'active',
      roleIds: [admin._id],
      projectAccessMode: 'all',
      passwordHash,
      createdBy: null,
      updatedBy: null,
    });
    const viewer = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: `ret-view-${org._id}@example.com`,
      displayName: 'Retention Viewer',
      userStatus: 'active',
      roleIds: [member._id],
      projectAccessMode: 'all',
      passwordHash,
      createdBy: null,
      updatedBy: null,
    });

    app = buildApp(TEST_APP_CONFIG);
    await app.ready();

    const deniedLogin = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/access/auth/login`,
      payload: { email: viewer.email, password: 'Retention1!' },
    });
    expect(deniedLogin.statusCode).toBe(200);
    const denied = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/organizations/getRetentionPolicy`,
      headers: { authorization: `Bearer ${deniedLogin.json().accessToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const allowedLogin = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/access/auth/login`,
      payload: { email: manager.email, password: 'Retention1!' },
    });
    expect(allowedLogin.statusCode).toBe(200);
    const token = allowedLogin.json().accessToken;
    const getRes = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/masters/organizations/getRetentionPolicy`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().jobDays).toBe(180);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/masters/organizations/updateRetentionPolicy`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': `ret-${new mongoose.Types.ObjectId().toHexString()}`,
      },
      payload: { conversationDays: 400 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().conversationDays).toBe(400);
  });
});
