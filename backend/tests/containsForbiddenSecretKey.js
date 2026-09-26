/**
 * DTO leak check used by identity tests — not a production export.
 */
const FORBIDDEN_RESPONSE_KEYS = Object.freeze([
  'passwordHash',
  'password',
  'newPassword',
  'refreshToken',
  'refreshTokenHash',
  'token',
  'resetToken',
  'passwordResetToken',
]);

/**
 * Returns whether a plain object contains a forbidden credential-shaped key.
 * @param {unknown} value Candidate object.
 * @returns {boolean}
 */
export function containsForbiddenSecretKey(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_RESPONSE_KEYS.includes(key)) {
        return true;
      }
      if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }
  return false;
}
