/**
 * Unit tests for late-bound idempotency error hooks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isIdempotencyReplayError,
  releaseIdempotencyClaimOnError,
  resetIdempotencyErrorHooks,
  setIdempotencyErrorHooks,
} from '../errors.js';

describe('idempotencyErrorHooks', () => {
  afterEach(() => {
    resetIdempotencyErrorHooks();
  });

  it('default detector recognizes IdempotencyReplay by name', () => {
    resetIdempotencyErrorHooks();
    expect(isIdempotencyReplayError({ name: 'IdempotencyReplay' })).toBe(true);
    expect(isIdempotencyReplayError({ name: 'Error' })).toBe(false);
    expect(isIdempotencyReplayError(null)).toBe(false);
    expect(isIdempotencyReplayError('x')).toBe(false);
  });

  it('setIdempotencyErrorHooks replaces release and detector', async () => {
    const release = vi.fn(async () => {});
    setIdempotencyErrorHooks({
      isReplayError: () => true,
      releaseOwnedClaim: release,
    });
    expect(isIdempotencyReplayError(new Error('any'))).toBe(true);
    await releaseIdempotencyClaimOnError(/** @type {any} */ ({}));
    expect(release).toHaveBeenCalled();
  });
});
