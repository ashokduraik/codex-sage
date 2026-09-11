import { describe, it, expect } from 'vitest';
import {
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  classifyRetryability,
  computeRetryDelayMs,
  isAutoRetryable,
} from './retryPolicy.js';

describe('classifyRetryability', () => {
  it('returns the catalog verdict for a known code', () => {
    expect(classifyRetryability('KNOWLEDGE_UNAVAILABLE')).toBe('temporary');
    expect(classifyRetryability('NOT_FOUND')).toBe('user_action_required');
    expect(classifyRetryability('INTERNAL_ERROR')).toBe('permanent');
  });

  it('returns permanent for unknown codes', () => {
    expect(classifyRetryability('NOT_A_REAL_CODE')).toBe('permanent');
  });
});

describe('isAutoRetryable', () => {
  it('is true only for temporary codes', () => {
    expect(isAutoRetryable('SERVICE_UNAVAILABLE')).toBe(true);
    expect(isAutoRetryable('FORBIDDEN')).toBe(false);
    expect(isAutoRetryable('VALIDATION_ERROR')).toBe(false);
  });
});

describe('computeRetryDelayMs', () => {
  it('grows exponentially and never exceeds the max delay', () => {
    const alwaysMax = () => 1;
    const delay0 = computeRetryDelayMs(0, {}, alwaysMax);
    const delay1 = computeRetryDelayMs(1, {}, alwaysMax);
    const delay2 = computeRetryDelayMs(2, {}, alwaysMax);
    expect(delay0).toBe(RETRY_BASE_DELAY_MS);
    expect(delay1).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(delay2).toBe(RETRY_BASE_DELAY_MS * 4);
    const huge = computeRetryDelayMs(20, {}, alwaysMax);
    expect(huge).toBe(RETRY_MAX_DELAY_MS);
  });

  it('stays inside the jitter window under a stubbed random source', () => {
    const half = () => 0.5;
    const ceiling = RETRY_BASE_DELAY_MS;
    const delay = computeRetryDelayMs(0, {}, half);
    expect(delay).toBe(Math.floor(0.5 * (ceiling + 1)));
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(ceiling);
  });

  it('returns 0 when random is 0', () => {
    expect(computeRetryDelayMs(0, {}, () => 0)).toBe(0);
  });
});
