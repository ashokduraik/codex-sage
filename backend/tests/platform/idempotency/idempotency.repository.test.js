/**
 * Unit tests for idempotency repository helpers (no Mongo).
 */
import { describe, expect, it } from 'vitest';
import {
  buildIdempotencyRouteLabel,
  isMongoDuplicateKeyError,
} from '../../../src/platform/idempotency/idempotency.repository.js';
import { IdempotencyReplay } from '../../../src/platform/idempotency/idempotency.middleware.js';

describe('buildIdempotencyRouteLabel', () => {
  it('uppercases the method and keeps the path template', () => {
    expect(buildIdempotencyRouteLabel('post', '/users')).toBe('POST /users');
  });
});

describe('isMongoDuplicateKeyError', () => {
  it('detects Mongo duplicate key code 11000', () => {
    expect(isMongoDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isMongoDuplicateKeyError({ code: 1 })).toBe(false);
    expect(isMongoDuplicateKeyError(null)).toBe(false);
  });
});

describe('IdempotencyReplay', () => {
  it('carries status and body for the error-handler wrapper', () => {
    const replay = new IdempotencyReplay(201, { id: 'u1' });
    expect(replay).toBeInstanceOf(Error);
    expect(replay.name).toBe('IdempotencyReplay');
    expect(replay.responseStatus).toBe(201);
    expect(replay.responseBody).toEqual({ id: 'u1' });
  });
});
