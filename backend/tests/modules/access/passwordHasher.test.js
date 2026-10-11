/**
 * Unit tests for argon2id passwordHasher.
 */
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import {
  needsRehash,
  hashPassword,
  verifyPassword,
  ARGON2_TIME_COST,
  ARGON2_PARALLELISM,
  getDummyPasswordHash,
  ARGON2_MEMORY_COST_KIB,
} from '../../../src/modules/access/auth.js';

describe('passwordHasher', () => {
  it('hashes a password that verifies and differs across calls (salted)', async () => {
    const first = await hashPassword('correct-horse');
    const second = await hashPassword('correct-horse');
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, 'correct-horse')).toBe(true);
    expect(await verifyPassword(second, 'correct-horse')).toBe(true);
  });

  it('returns false for a wrong password and for a malformed stored hash', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-valid-argon-hash', 'correct-horse')).toBe(false);
  });

  it('reports needsRehash when stored parameters are below current constants', async () => {
    const current = await hashPassword('x');
    expect(needsRehash(current)).toBe(false);
    const weak = await argon2.hash('x', {
      type: argon2.argon2id,
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
    });
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash('bogus')).toBe(true);
    expect(ARGON2_MEMORY_COST_KIB).toBe(19_456);
    expect(ARGON2_TIME_COST).toBe(2);
    expect(ARGON2_PARALLELISM).toBe(1);
  });

  it('exposes a dummy hash for timing-safe unknown-user verifies', async () => {
    const first = await getDummyPasswordHash();
    const second = await getDummyPasswordHash();
    expect(first).toBe(second);
    expect(await verifyPassword(first, 'anything')).toBe(false);
  });
});
