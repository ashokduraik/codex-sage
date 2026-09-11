/**
 * argon2id password hashing — the only module that imports `argon2`.
 * Cost parameters are named constants (not env).
 */
import argon2 from 'argon2';

/** OWASP Password Storage Cheat Sheet minimum (m=19456 KiB, t=2, p=1). */
export const ARGON2_MEMORY_COST_KIB = 19_456;
/** argon2id time cost (iterations). */
export const ARGON2_TIME_COST = 2;
/** argon2id parallelism (lanes). */
export const ARGON2_PARALLELISM = 1;

const HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: ARGON2_MEMORY_COST_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
});

/** Dummy hash used so unknown-user login still burns verify time. */
let dummyHashPromise;

/**
 * Returns a once-computed dummy argon2id hash for timing-safe failed logins.
 * @returns {Promise<string>}
 */
export async function getDummyPasswordHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash('__codex-sage-timing-dummy__', HASH_OPTIONS);
  }
  return dummyHashPromise;
}

/**
 * Hashes a plaintext password with argon2id.
 * @param {string} password Plaintext password.
 * @returns {Promise<string>} Encoded argon2id hash.
 */
export async function hashPassword(password) {
  return argon2.hash(password, HASH_OPTIONS);
}

/**
 * Verifies a plaintext password against a stored argon2id hash.
 * @param {string} hash Stored hash.
 * @param {string} password Candidate plaintext.
 * @returns {Promise<boolean>} True when the password matches.
 */
export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * True when the stored hash uses weaker parameters than the current constants.
 * @param {string} hash Stored argon2id hash.
 * @returns {boolean}
 */
export function needsRehash(hash) {
  try {
    return argon2.needsRehash(hash, HASH_OPTIONS);
  } catch {
    return true;
  }
}
