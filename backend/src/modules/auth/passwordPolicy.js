/**
 * Password policy — returns machine-readable violation codes for UI localisation.
 */

/** Minimum accepted password length (locked Phase 08). */
export const PASSWORD_MIN_LENGTH = 6;

/**
 * Number of previous hashes checked for reuse. `0` disables history storage and checks.
 */
export const PASSWORD_HISTORY_LENGTH = 0;

/**
 * @typedef {'TOO_SHORT' | 'SAME_AS_CURRENT' | 'RECENTLY_USED'} PasswordPolicyViolation
 */

/**
 * Validates a candidate password against the policy.
 * @param {string} candidate Plaintext candidate.
 * @param {{
 *   currentHash?: string | null,
 *   verifyPassword?: (hash: string, password: string) => Promise<boolean>,
 * }} [options] Optional current-hash check.
 * @returns {Promise<PasswordPolicyViolation[]>}
 */
export async function validatePasswordCandidate(candidate, options = {}) {
  /** @type {PasswordPolicyViolation[]} */
  const violations = [];
  if (typeof candidate !== 'string' || candidate.length < PASSWORD_MIN_LENGTH) {
    violations.push('TOO_SHORT');
  }

  if (
    options.currentHash &&
    typeof options.verifyPassword === 'function' &&
    candidate.length > 0
  ) {
    const matchesCurrent = await options.verifyPassword(options.currentHash, candidate);
    if (matchesCurrent) {
      violations.push('SAME_AS_CURRENT');
    }
  }

  // PASSWORD_HISTORY_LENGTH === 0: no RECENTLY_USED check and no history storage.
  return violations;
}
