/**
 * Unit/integration tests for audit model, repository, and service helpers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { encodeCursor, ROW_STATUS_DELETED } from '../../../src/platform/data/index.js';
import { IDENTITY_MODELS, createOrganization } from '../../../src/modules/masters/index.js';
import { AUDIT_MODELS } from '../../../src/modules/access/audit.js';
import { AuditEvent } from '../../../src/models/audit.model.js';
import {
  clampAuditListLimit,
  AUDIT_LIST_PAGE_SIZE_DEFAULT,
  AUDIT_LIST_PAGE_SIZE_MAX,
  insertAuditEvent,
  listAuditEvents,
} from '../../../src/modules/access/audit.js';
import {
  buildAuditContextFromRequest,
  recordAuditEvent,
  shouldAuditAuthorizationDenial,
} from '../../../src/modules/access/audit.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUDIT_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('audit model, repository, and service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('throws on updateOne / deleteOne without retentionJob', async () => {
    const org = await createOrganization({
      name: 'Audit Org',
      slug: `audit-org-${Date.now()}`,
    });
    const doc = await insertAuditEvent({
      orgId: org._id,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-testappendonly1',
    });

    await expect(
      AuditEvent.updateOne({ _id: doc._id }, { $set: { action: 'x' } }),
    ).rejects.toThrow(/append-only/);

    await expect(AuditEvent.deleteOne({ _id: doc._id })).rejects.toThrow(
      /append-only|hard-delete/,
    );
  });

  it('allows retentionJob soft-delete to status D only', async () => {
    const org = await createOrganization({
      name: 'Audit Org 2',
      slug: `audit-org2-${Date.now()}`,
    });
    const doc = await insertAuditEvent({
      orgId: org._id,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-testappendonly2',
    });

    await AuditEvent.updateOne(
      { _id: doc._id },
      { $set: { status: ROW_STATUS_DELETED } },
      { retentionJob: true },
    );

    const listed = await listAuditEvents(org._id);
    expect(listed.items).toHaveLength(0);

    await expect(
      AuditEvent.updateOne(
        { _id: doc._id },
        { $set: { action: 'nope' } },
        { retentionJob: true },
      ),
    ).rejects.toThrow(/status to D/);

    await expect(
      AuditEvent.deleteMany({ _id: doc._id }, { retentionJob: true }),
    ).rejects.toThrow(/soft-delete/);

    await expect(
      AuditEvent.findOneAndDelete({ _id: doc._id }),
    ).rejects.toThrow(/append-only/);

    await expect(
      AuditEvent.findOneAndUpdate(
        { _id: doc._id },
        { $set: { action: 'x' } },
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      AuditEvent.updateOne(
        { _id: doc._id },
        { status: ROW_STATUS_DELETED },
        { retentionJob: true },
      ),
    ).rejects.toThrow(/status to D/);

    await expect(
      AuditEvent.updateOne(
        { _id: doc._id },
        { $set: { status: ROW_STATUS_DELETED }, $unset: { action: 1 } },
        { retentionJob: true },
      ),
    ).rejects.toThrow(/status to D/);

    await expect(
      AuditEvent.updateMany(
        { _id: doc._id },
        { $set: { status: ROW_STATUS_DELETED } },
        { retentionJob: true },
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects mismatched resourceType and invalid result without throwing', async () => {
    const org = await createOrganization({
      name: 'Audit Org mismatch',
      slug: `audit-mismatch-${Date.now()}`,
    });
    const error = vi.fn();
    await recordAuditEvent(
      {
        orgId: org._id,
        action: 'user.password_changed',
        resourceType: 'role',
        result: 'success',
        correlationId: 'REQ-mismatch',
      },
      { log: { error } },
    );
    expect(error).toHaveBeenCalled();

    error.mockClear();
    await recordAuditEvent(
      {
        orgId: org._id,
        action: 'user.password_changed',
        resourceType: 'user',
        result: /** @type {any} */ ('weird'),
        correlationId: 'REQ-bad-result',
      },
      { log: { error } },
    );
    expect(error).toHaveBeenCalled();

    error.mockClear();
    await recordAuditEvent(
      {
        orgId: org._id,
        action: 'user.password_changed',
        result: 'success',
        correlationId: 'REQ-default-type',
      },
      { log: { error } },
    );
    const listed = await listAuditEvents(org._id);
    expect(listed.items.some((row) => row.correlationId === 'REQ-default-type')).toBe(
      true,
    );
  });

  it('filters by from/to/actor/action/resourceType and rejects bad actor', async () => {
    const org = await createOrganization({
      name: 'Audit Org filters',
      slug: `audit-filters-${Date.now()}`,
    });
    const actor = new mongoose.Types.ObjectId();
    const older = await insertAuditEvent({
      orgId: org._id,
      actorUserId: actor,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-old',
    });
    await AuditEvent.collection.updateOne(
      { _id: older._id },
      { $set: { createdAt: new Date('2020-01-01T00:00:00.000Z') } },
    );
    await insertAuditEvent({
      orgId: org._id,
      actorUserId: actor,
      action: 'authz.denied',
      resourceType: 'route',
      result: 'denied',
      correlationId: 'REQ-new',
    });

    const filtered = await listAuditEvents(org._id, {
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2030-01-01T00:00:00.000Z'),
      actor: actor.toHexString(),
      action: 'authz.denied',
      resourceType: 'route',
    });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].correlationId).toBe('REQ-new');

    await expect(
      listAuditEvents(org._id, { actor: 'not-an-id' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      listAuditEvents(org._id, {
        cursor: encodeCursor({ t: 'not-a-date', i: actor.toHexString() }),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      listAuditEvents(org._id, {
        cursor: encodeCursor({
          t: '2026-01-01T00:00:00.000Z',
          i: 'zzzz',
        }),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns null for invalid detail ids', async () => {
    const org = await createOrganization({
      name: 'Audit Org detail',
      slug: `audit-detail-${Date.now()}`,
    });
    const { findAuditEventById } = await import('../../../src/modules/access/audit.js');
    expect(await findAuditEventById(org._id, 'bad')).toBeNull();
  });

  it('clamps limit to the configured range', () => {
    expect(clampAuditListLimit(undefined)).toBe(AUDIT_LIST_PAGE_SIZE_DEFAULT);
    expect(clampAuditListLimit(0)).toBe(AUDIT_LIST_PAGE_SIZE_DEFAULT);
    expect(clampAuditListLimit(10)).toBe(10);
    expect(clampAuditListLimit(AUDIT_LIST_PAGE_SIZE_MAX + 50)).toBe(
      AUDIT_LIST_PAGE_SIZE_MAX,
    );
  });

  it('logs and does not throw when required fields are missing', async () => {
    const error = vi.fn();
    await expect(
      recordAuditEvent(
        /** @type {any} */ ({
          action: 'user.password_changed',
          result: 'success',
        }),
        { log: { error } },
      ),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('rejects unknown actions without throwing to the caller', async () => {
    const org = await createOrganization({
      name: 'Audit Org 3',
      slug: `audit-org3-${Date.now()}`,
    });
    const error = vi.fn();
    await recordAuditEvent(
      {
        orgId: org._id,
        action: 'user.invented',
        resourceType: 'user',
        result: 'success',
        correlationId: 'REQ-unknownaction',
      },
      { log: { error } },
    );
    expect(error).toHaveBeenCalled();
    const listed = await listAuditEvents(org._id);
    expect(listed.items).toHaveLength(0);
  });

  it('inserts a valid event with sanitized context', async () => {
    const org = await createOrganization({
      name: 'Audit Org 4',
      slug: `audit-org4-${Date.now()}`,
    });
    await recordAuditEvent({
      orgId: org._id,
      action: 'user.password_changed',
      resourceType: 'user',
      result: 'success',
      correlationId: 'REQ-validinsert',
      context: { reason: 'self_change', password: 'should-redact' },
    });
    const listed = await listAuditEvents(org._id);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].context.password).toBe('[redacted]');
    expect(listed.items[0].context.reason).toBe('self_change');
  });

  it('paginates with a keyset cursor without duplicates', async () => {
    const org = await createOrganization({
      name: 'Audit Org 5',
      slug: `audit-org5-${Date.now()}`,
    });
    for (let i = 0; i < 3; i += 1) {
      await insertAuditEvent({
        orgId: org._id,
        action: 'user.password_changed',
        resourceType: 'user',
        result: 'success',
        correlationId: `REQ-page-${i}`,
      });
    }
    const page1 = await listAuditEvents(org._id, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.pageInfo.hasMore).toBe(true);
    expect(page1.pageInfo.nextCursor).toBeTruthy();

    const page2 = await listAuditEvents(org._id, {
      limit: 2,
      cursor: page1.pageInfo.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.pageInfo.hasMore).toBe(false);
    const ids = [...page1.items, ...page2.items].map((d) => String(d._id));
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects a malformed cursor with VALIDATION_ERROR', async () => {
    const org = await createOrganization({
      name: 'Audit Org 6',
      slug: `audit-org6-${Date.now()}`,
    });
    await expect(listAuditEvents(org._id, { cursor: '!!!' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('extracts request fields without touching reply', () => {
    const ctx = buildAuditContextFromRequest(
      /** @type {any} */ ({
        id: 'REQ-abc',
        ip: '203.0.113.8',
        headers: { 'user-agent': 'Mozilla/5.0' },
        principal: { orgId: 'o1', userId: 'u1' },
      }),
    );
    expect(ctx).toEqual({
      orgId: 'o1',
      actorUserId: 'u1',
      correlationId: 'REQ-abc',
      ip: '203.0.113.8',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('audits only admin/security permission denials', () => {
    expect(shouldAuditAuthorizationDenial(['users.manage'])).toBe(true);
    expect(shouldAuditAuthorizationDenial(['roles.manage'])).toBe(true);
    expect(shouldAuditAuthorizationDenial(['audit.view'])).toBe(true);
    expect(shouldAuditAuthorizationDenial(['projects.view'])).toBe(false);
    expect(shouldAuditAuthorizationDenial([])).toBe(false);
  });

  it('round-trips encodeCursor for list pages', () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    const cursor = encodeCursor({ t: '2026-09-11T00:00:00.000Z', i: id });
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
  });
});
