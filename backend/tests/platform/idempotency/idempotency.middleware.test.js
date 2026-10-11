/**
 * Unit tests for idempotency onSend / preHandler edge cases.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import {
  IDEMPOTENCY_BODY_MAX_BYTES,
  IdempotencyReplay,
  hashIdempotencyRequestBody,
  idempotencyOnSend,
  idempotencyPreHandler,
  releaseOwnedIdempotencyClaim,
} from '../../../src/platform/idempotency/idempotency.middleware.js';

vi.mock('../../../src/platform/idempotency/idempotency.repository.js', () => ({
  beginIdempotencyClaim: vi.fn(),
  completeIdempotencyRecord: vi.fn(),
  findActiveIdempotencyRecord: vi.fn(),
  releaseIdempotencyClaim: vi.fn(async () => {}),
  IDEMPOTENCY_WAIT_MS: 50,
  IDEMPOTENCY_POLL_INTERVAL_MS: 5,
}));

import {
  beginIdempotencyClaim,
  completeIdempotencyRecord,
  findActiveIdempotencyRecord,
  releaseIdempotencyClaim,
} from '../../../src/platform/idempotency/idempotency.repository.js';

describe('idempotencyOnSend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when the request does not own a claim', async () => {
    const payload = await idempotencyOnSend({ idempotency: null }, { statusCode: 201 }, '{"ok":true}');
    expect(payload).toBe('{"ok":true}');
    expect(completeIdempotencyRecord).not.toHaveBeenCalled();
  });

  it('skips non-2xx responses', async () => {
    const request = {
      idempotency: { isOwner: true, recordId: 'r1' },
      principal: { orgId: 'o1', userId: 'u1' },
    };
    const payload = await idempotencyOnSend(request, { statusCode: 400 }, '{"err":true}');
    expect(payload).toBe('{"err":true}');
    expect(completeIdempotencyRecord).not.toHaveBeenCalled();
  });

  it('releases and throws when the body exceeds the storage cap', async () => {
    const huge = { data: 'x'.repeat(IDEMPOTENCY_BODY_MAX_BYTES) };
    const request = {
      idempotency: { isOwner: true, recordId: 'r1' },
      principal: { orgId: 'o1', userId: 'u1' },
    };
    await expect(idempotencyOnSend(request, { statusCode: 201 }, JSON.stringify(huge))).rejects.toBeInstanceOf(ApiError);
    expect(releaseIdempotencyClaim).toHaveBeenCalled();
  });

  it('completes the claim for a successful JSON body with id', async () => {
    const request = {
      idempotency: { isOwner: true, recordId: 'r1' },
      principal: { orgId: 'o1', userId: 'u1' },
    };
    const payload = await idempotencyOnSend(request, { statusCode: 201 }, '{"id":"abc123","email":"a@example.com"}');
    expect(payload).toBe('{"id":"abc123","email":"a@example.com"}');
    expect(completeIdempotencyRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'o1',
        recordId: 'r1',
        responseStatus: 201,
        resourceId: 'abc123',
      }),
    );
    expect(request.idempotency.isOwner).toBe(false);
  });

  it('accepts Buffer payloads and empty bodies without a resource id', async () => {
    const request = {
      idempotency: { isOwner: true, recordId: 'r1' },
      principal: { orgId: 'o1', userId: 'u1' },
    };
    await idempotencyOnSend(request, { statusCode: 204 }, '');
    expect(completeIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({ responseBody: null, resourceId: null }));

    request.idempotency.isOwner = true;
    await idempotencyOnSend(request, { statusCode: 201 }, Buffer.from('{"ok":true}', 'utf8'));
    expect(completeIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({ responseBody: { ok: true }, resourceId: null }));

    request.idempotency.isOwner = true;
    await idempotencyOnSend(request, { statusCode: 201 }, 'not-json');
    expect(completeIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({ responseBody: 'not-json' }));

    request.idempotency.isOwner = true;
    await idempotencyOnSend(request, { statusCode: 201 }, Buffer.from('not-json', 'utf8'));
    expect(completeIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({ responseBody: 'not-json' }));

    request.idempotency.isOwner = true;
    await idempotencyOnSend(request, { statusCode: 201 }, { id: 42 });
    expect(completeIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({ resourceId: null }));
  });
});

describe('idempotencyPreHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when the route does not require a key', async () => {
    await idempotencyPreHandler({
      routeOptions: { config: {} },
    });
    expect(beginIdempotencyClaim).not.toHaveBeenCalled();
  });

  it('throws UNAUTHENTICATED when a required route has no principal', async () => {
    await expect(
      idempotencyPreHandler({
        routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
        principal: null,
        headers: { 'idempotency-key': 'abcdefgh' },
        method: 'POST',
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('sets ownership context for the first writer', async () => {
    beginIdempotencyClaim.mockResolvedValue({
      owned: true,
      record: { _id: 'rec1' },
    });
    const request = {
      routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
      principal: { orgId: 'o1', userId: 'u1' },
      headers: { 'idempotency-key': 'abcdefgh' },
      method: 'POST',
      body: { email: 'a@example.com' },
    };
    await idempotencyPreHandler(request);
    expect(request.idempotency).toMatchObject({
      isOwner: true,
      recordId: 'rec1',
    });
  });

  it('replays a completed twin with the same hash', async () => {
    const body = { a: 1 };
    const hash = hashIdempotencyRequestBody(body);
    beginIdempotencyClaim.mockResolvedValue({
      owned: false,
      record: {
        requestHash: hash,
        recordState: 'completed',
        responseStatus: 201,
        responseBody: { id: 'u1' },
      },
    });

    await expect(
      idempotencyPreHandler({
        routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
        principal: { orgId: 'o1', userId: 'u1' },
        headers: { 'idempotency-key': 'abcdefgh' },
        method: 'POST',
        body,
      }),
    ).rejects.toBeInstanceOf(IdempotencyReplay);
  });

  it('rejects a twin with a different request hash', async () => {
    beginIdempotencyClaim.mockResolvedValue({
      owned: false,
      record: {
        requestHash: 'other-hash',
        recordState: 'processing',
      },
    });
    await expect(
      idempotencyPreHandler({
        routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
        principal: { orgId: 'o1', userId: 'u1' },
        headers: { 'idempotency-key': 'abcdefgh' },
        method: 'POST',
        body: { a: 1 },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' });
  });

  it('throws IDEMPOTENCY_IN_FLIGHT when the twin never completes', async () => {
    const body = { a: 1 };
    const hash = hashIdempotencyRequestBody(body);
    beginIdempotencyClaim.mockResolvedValue({
      owned: false,
      record: {
        requestHash: hash,
        recordState: 'processing',
      },
    });
    findActiveIdempotencyRecord.mockResolvedValue({
      requestHash: hash,
      recordState: 'processing',
    });

    await expect(
      idempotencyPreHandler({
        routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
        principal: { orgId: 'o1', userId: 'u1' },
        headers: { 'idempotency-key': 'abcdefgh' },
        method: 'POST',
        body,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_FLIGHT' });
  });

  it('replays after waiting when the twin completes', async () => {
    const body = { a: 1 };
    const hash = hashIdempotencyRequestBody(body);
    beginIdempotencyClaim.mockResolvedValue({
      owned: false,
      record: {
        requestHash: hash,
        recordState: 'processing',
      },
    });
    findActiveIdempotencyRecord
      .mockResolvedValueOnce({
        requestHash: hash,
        recordState: 'processing',
      })
      .mockResolvedValueOnce({
        requestHash: hash,
        recordState: 'completed',
        responseStatus: 201,
        responseBody: { id: 'done' },
      });

    await expect(
      idempotencyPreHandler({
        routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
        principal: { orgId: 'o1', userId: 'u1' },
        headers: { 'idempotency-key': 'abcdefgh' },
        method: 'POST',
        body,
      }),
    ).rejects.toMatchObject({
      name: 'IdempotencyReplay',
      responseBody: { id: 'done' },
    });
  });

  it('throws IDEMPOTENCY_IN_FLIGHT when the twin disappears while waiting', async () => {
    const body = { a: 1 };
    const hash = hashIdempotencyRequestBody(body);
    beginIdempotencyClaim.mockResolvedValue({
      owned: false,
      record: {
        requestHash: hash,
        recordState: 'processing',
      },
    });
    findActiveIdempotencyRecord.mockResolvedValue(null);

    await expect(
      idempotencyPreHandler({
        routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
        principal: { orgId: 'o1', userId: 'u1' },
        headers: { 'idempotency-key': 'abcdefgh' },
        method: 'POST',
        body,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_FLIGHT' });
  });

  it('throws IDEMPOTENCY_KEY_REUSE when the twin hash changes while waiting', async () => {
    const body = { a: 1 };
    const hash = hashIdempotencyRequestBody(body);
    beginIdempotencyClaim.mockResolvedValue({
      owned: false,
      record: {
        requestHash: hash,
        recordState: 'processing',
      },
    });
    findActiveIdempotencyRecord.mockResolvedValue({
      requestHash: 'changed',
      recordState: 'processing',
    });

    await expect(
      idempotencyPreHandler({
        routeOptions: { config: { requireIdempotencyKey: true }, url: '/users' },
        principal: { orgId: 'o1', userId: 'u1' },
        headers: { 'idempotency-key': 'abcdefgh' },
        method: 'POST',
        body,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' });
  });
});

describe('releaseOwnedIdempotencyClaim', () => {
  it('no-ops without an owned claim', async () => {
    releaseIdempotencyClaim.mockClear();
    await releaseOwnedIdempotencyClaim({ idempotency: null });
    expect(releaseIdempotencyClaim).not.toHaveBeenCalled();
  });
});
