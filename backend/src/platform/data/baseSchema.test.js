/**
 * Base schema behaviour against the external replica set (D16).
 */
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../errors.js';
import {
  assertOrgId,
  createBaseSchema,
  includeDeleted,
  softDelete,
} from './baseSchema.js';
import { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from './baseSchema.js';
import { syncSchemaIndexes } from './index.js';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';

const tenantSchema = createBaseSchema({
  name: { type: String, required: true },
});
tenantSchema.index(
  { orgId: 1, createdAt: -1, _id: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

const TenantFixture =
  mongoose.models.TenantFixture ??
  mongoose.model('TenantFixture', tenantSchema, 'tenant_fixtures');

const platformSchema = createBaseSchema(
  { name: { type: String, required: true } },
  { tenantScoped: false },
);
const PlatformFixture =
  mongoose.models.PlatformFixture ??
  mongoose.model('PlatformFixture', platformSchema, 'platform_fixtures');

const harness = createMongoHarness({
  models: [TenantFixture, PlatformFixture],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('createBaseSchema', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('defaults status to A on insert', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const doc = await TenantFixture.create({
      name: 'alpha',
      orgId,
      createdBy: null,
      updatedBy: null,
    });
    expect(doc.status).toBe(ROW_STATUS_ACTIVE);
  });

  it('rejects a status outside A|D', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await expect(
      TenantFixture.create({
        name: 'bad',
        orgId,
        status: 'X',
      }),
    ).rejects.toThrow();
  });

  it('hides soft-deleted rows from default find and reveals them via includeDeleted', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const doc = await TenantFixture.create({ name: 'visible', orgId });
    await softDelete(TenantFixture, { _id: doc._id, orgId });
    const active = await TenantFixture.find({ orgId });
    expect(active).toHaveLength(0);
    const all = await includeDeleted(TenantFixture.find({ orgId }));
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(ROW_STATUS_DELETED);
  });

  it('updates updatedAt and updatedBy on update', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const doc = await TenantFixture.create({
      name: 'stamp',
      orgId,
      createdBy: actor,
      updatedBy: actor,
    });
    const before = doc.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    doc.name = 'stamped';
    doc.updatedBy = actor;
    await doc.save();
    expect(doc.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(doc.updatedBy?.equals(actor)).toBe(true);
  });

  it('rejects insert without orgId on a tenant schema', async () => {
    await expect(TenantFixture.create({ name: 'no-org' })).rejects.toSatisfy((err) => {
      return err instanceof ApiError && err.code === 'TENANT_SCOPE_MISSING';
    });
  });

  it('allows a platform schema without orgId', async () => {
    const doc = await PlatformFixture.create({ name: 'platform' });
    expect(doc.orgId).toBeUndefined();
    expect(doc.status).toBe(ROW_STATUS_ACTIVE);
  });

  it('softDelete on an already-D row matches zero documents', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const doc = await TenantFixture.create({ name: 'once', orgId });
    await softDelete(TenantFixture, { _id: doc._id, orgId });
    const second = await softDelete(TenantFixture, { _id: doc._id, orgId });
    expect(second.matchedCount).toBe(0);
  });

  it('softDelete without updatedBy succeeds for system actors', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const doc = await TenantFixture.create({ name: 'system', orgId });
    const result = await softDelete(TenantFixture, { _id: doc._id, orgId });
    expect(result.modifiedCount).toBe(1);
    const deleted = await includeDeleted(TenantFixture.findOne({ _id: doc._id }));
    expect(deleted?.updatedBy).toBeNull();
  });

  it('assertOrgId throws TENANT_SCOPE_MISSING when orgId is missing', () => {
    expect(() => assertOrgId(null)).toThrow(ApiError);
    expect(() => assertOrgId(new mongoose.Types.ObjectId())).not.toThrow();
  });

  it('declares compound indexes after syncSchemaIndexes', async () => {
    await syncSchemaIndexes([TenantFixture]);
    const indexes = await TenantFixture.collection.indexes();
    const keyset = indexes.find(
      (idx) =>
        idx.key?.orgId === 1 && idx.key?.createdAt === -1 && idx.key?._id === -1,
    );
    expect(keyset).toBeDefined();
  });
});
