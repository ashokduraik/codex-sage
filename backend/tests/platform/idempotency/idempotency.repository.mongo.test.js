/**
 * Integration tests for idempotency repository claim / complete / release.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import {
  IDEMPOTENCY_MODELS,
  IdempotencyRecord,
  beginIdempotencyClaim,
  completeIdempotencyRecord,
  findActiveIdempotencyRecord,
  releaseIdempotencyClaim,
} from '../../../src/platform/idempotency/index.js';

const harness = createMongoHarness({
  models: [...IDEMPOTENCY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('idempotency.repository (mongo)', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('lets the first writer own the claim and the second see the same key', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const input = {
      orgId,
      userId,
      route: 'POST /users',
      key: 'repo-claim-1',
      requestHash: 'hash-a',
      createdBy: userId,
    };

    const first = await beginIdempotencyClaim(input);
    expect(first.owned).toBe(true);
    expect(first.record.recordState).toBe('processing');

    const second = await beginIdempotencyClaim(input);
    expect(second.owned).toBe(false);
    expect(String(second.record._id)).toBe(String(first.record._id));
  });

  it('completes a claim so findActive returns the stored response', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const { record } = await beginIdempotencyClaim({
      orgId,
      userId,
      route: 'POST /users',
      key: 'repo-complete-1',
      requestHash: 'hash-b',
      createdBy: userId,
    });

    await completeIdempotencyRecord({
      orgId,
      recordId: record._id,
      responseStatus: 201,
      responseBody: { id: 'user-1' },
      resourceId: new mongoose.Types.ObjectId(),
      updatedBy: userId,
    });

    const found = await findActiveIdempotencyRecord({
      orgId,
      userId,
      route: 'POST /users',
      key: 'repo-complete-1',
    });
    expect(found?.recordState).toBe('completed');
    expect(found?.responseStatus).toBe(201);
    expect(found?.responseBody).toEqual({ id: 'user-1' });
  });

  it('releases a processing claim so the key can be claimed again', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const { record } = await beginIdempotencyClaim({
      orgId,
      userId,
      route: 'POST /users',
      key: 'repo-release-1',
      requestHash: 'hash-c',
      createdBy: userId,
    });

    await releaseIdempotencyClaim({
      orgId,
      recordId: record._id,
      updatedBy: userId,
    });

    expect(
      await findActiveIdempotencyRecord({
        orgId,
        userId,
        route: 'POST /users',
        key: 'repo-release-1',
      }),
    ).toBeNull();

    const again = await beginIdempotencyClaim({
      orgId,
      userId,
      route: 'POST /users',
      key: 'repo-release-1',
      requestHash: 'hash-c',
      createdBy: userId,
    });
    expect(again.owned).toBe(true);
    expect(await IdempotencyRecord.countDocuments({})).toBe(1);
  });

  it('rethrows non-duplicate errors from create', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const spy = vi.spyOn(IdempotencyRecord, 'create').mockRejectedValueOnce(new Error('boom'));
    await expect(
      beginIdempotencyClaim({
        orgId,
        userId,
        route: 'POST /users',
        key: 'repo-boom-1',
        requestHash: 'hash-e',
        createdBy: userId,
      }),
    ).rejects.toThrow('boom');
    spy.mockRestore();
  });

  it('reclaims after an expired active row is released', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const { record } = await beginIdempotencyClaim({
      orgId,
      userId,
      route: 'POST /users',
      key: 'repo-expired-1',
      requestHash: 'hash-d',
      createdBy: userId,
    });

    await IdempotencyRecord.updateOne(
      { _id: record._id },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    ).exec();

    expect(
      await findActiveIdempotencyRecord({
        orgId,
        userId,
        route: 'POST /users',
        key: 'repo-expired-1',
      }),
    ).toBeNull();

    const reclaimed = await beginIdempotencyClaim({
      orgId,
      userId,
      route: 'POST /users',
      key: 'repo-expired-1',
      requestHash: 'hash-d',
      createdBy: userId,
    });
    expect(reclaimed.owned).toBe(true);
  });

  it('throws when a duplicate conflict cannot resolve an active record', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const createSpy = vi
      .spyOn(IdempotencyRecord, 'create')
      .mockRejectedValue({ code: 11000 });
    const findSpy = vi.spyOn(IdempotencyRecord, 'findOne').mockReturnValue({
      exec: async () => null,
    });
    await expect(
      beginIdempotencyClaim({
        orgId,
        userId,
        route: 'POST /users',
        key: 'repo-orphan-1',
        requestHash: 'hash-f',
        createdBy: userId,
      }),
    ).rejects.toThrow('idempotency claim conflict without an active record');
    createSpy.mockRestore();
    findSpy.mockRestore();
  });

  it('rethrows non-duplicate errors on the reclaim create path', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    let createCalls = 0;
    const createSpy = vi.spyOn(IdempotencyRecord, 'create').mockImplementation(async () => {
      createCalls += 1;
      if (createCalls === 1) {
        throw Object.assign(new Error('dup'), { code: 11000 });
      }
      throw new Error('retry-boom');
    });
    const findSpy = vi.spyOn(IdempotencyRecord, 'findOne').mockReturnValue({
      exec: async () => null,
    });
    await expect(
      beginIdempotencyClaim({
        orgId,
        userId,
        route: 'POST /users',
        key: 'repo-retry-boom-1',
        requestHash: 'hash-g',
        createdBy: userId,
      }),
    ).rejects.toThrow('retry-boom');
    createSpy.mockRestore();
    findSpy.mockRestore();
  });
});
