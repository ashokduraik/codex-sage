/**
 * Identity document → API DTO mappers (never expose secrets).
 */
import { getBuiltInRolePermissions } from '../authorization/builtInRolePermissions.js';
import { getPasswordResetStatus } from '../auth/password.service.js';

/** Keys that must never appear on identity response DTOs. */
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

/**
 * Maps a role document (and optional code-resolved permissions) to a DTO.
 * @param {object} role Role document or lean object.
 * @returns {{
 *   id: string,
 *   name: string,
 *   description: string | null,
 *   permissions: string[],
 *   isBuiltIn: boolean,
 *   createdAt: string,
 * }}
 */
export function mapRoleToDto(role) {
  let permissions = Array.isArray(role.permissions) ? [...role.permissions] : [];
  if (role.isBuiltIn && role.builtInKey) {
    const fromCode = getBuiltInRolePermissions(role.builtInKey);
    if (fromCode) {
      permissions = [...fromCode];
    }
  }
  return {
    id: String(role._id ?? role.id),
    name: role.name,
    description: role.description ?? null,
    permissions,
    isBuiltIn: Boolean(role.isBuiltIn),
    createdAt:
      role.createdAt instanceof Date
        ? role.createdAt.toISOString()
        : String(role.createdAt ?? ''),
  };
}

/**
 * Maps a user document plus role docs to the admin user DTO.
 * @param {object} user User document.
 * @param {object[]} roles Role documents (org-scoped).
 * @returns {object}
 */
export function mapUserToDto(user, roles = []) {
  const reset = getPasswordResetStatus(user);
  return {
    id: String(user._id ?? user.id),
    email: user.email,
    displayName: user.displayName,
    userStatus: user.userStatus,
    roles: roles.map((role) => ({
      id: String(role._id ?? role.id),
      name: role.name,
      isBuiltIn: Boolean(role.isBuiltIn),
    })),
    lastLoginAt:
      user.lastLoginAt instanceof Date ? user.lastLoginAt.toISOString() : null,
    passwordResetStatus: reset.state,
    passwordResetCompletedAt: reset.completedAt,
    createdAt:
      user.createdAt instanceof Date
        ? user.createdAt.toISOString()
        : String(user.createdAt ?? ''),
  };
}
