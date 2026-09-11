/**
 * Unit tests for password policy.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PASSWORD_HISTORY_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePasswordCandidate,
} from './passwordPolicy.js';

describe('passwordPolicy', () => {
  it('exports locked constants', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(6);
    expect(PASSWORD_HISTORY_LENGTH).toBe(0);
  });

  it('accepts a compliant password with no violations', async () => {
    const violations = await validatePasswordCandidate('abcdef');
    expect(violations).toEqual([]);
  });

  it('returns TOO_SHORT below the minimum', async () => {
    const violations = await validatePasswordCandidate('abc');
    expect(violations).toEqual(['TOO_SHORT']);
  });

  it('returns SAME_AS_CURRENT when the candidate matches the stored hash', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(true);
    const violations = await validatePasswordCandidate('abcdef', {
      currentHash: 'hash',
      verifyPassword,
    });
    expect(violations).toEqual(['SAME_AS_CURRENT']);
    expect(verifyPassword).toHaveBeenCalledWith('hash', 'abcdef');
  });

  it('skips history reuse checks when PASSWORD_HISTORY_LENGTH is 0', async () => {
    const violations = await validatePasswordCandidate('abcdefgh', {
      currentHash: 'hash',
      verifyPassword: vi.fn().mockResolvedValue(false),
    });
    expect(violations).not.toContain('RECENTLY_USED');
    expect(violations).toEqual([]);
  });
});
