/**
 * Auth service — login, refresh, logout as typed outcomes (Phase 10 audit hook).
 */
import { findMembership } from '../identity/membership.repository.js';
import {
  findActiveUsersByEmailWithPassword,
  findUserById,
  touchLastLoginAt,
  updateUserPasswordHash,
} from '../identity/user.repository.js';
import {
  getDummyPasswordHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './passwordHasher.js';
import {
  createSession,
  findSessionByRefreshTokenHash,
  isSessionActiveForRefresh,
  revokeSession,
  revokeSessionFamily,
  rotateSession,
} from './session.repository.js';
import {
  createTokenService,
  hashEmailForLog,
  hashRefreshToken,
  JWT_ACCESS_TOKEN_TTL_SECONDS,
  mintRefreshToken,
} from './tokenService.js';

/**
 * @typedef {'authenticated' | 'invalid_credentials' | 'not_permitted' | 'reuse_detected' | 'session_expired'} AuthOutcomeCode
 */

/**
 * @typedef {object} AuthUserSummary
 * @property {string} id
 * @property {string} email
 * @property {string} displayName
 * @property {string} orgId
 * @property {string[]} roleIds
 * @property {boolean} mustChangePassword
 */

/**
 * @typedef {object} AuthSuccessPayload
 * @property {AuthOutcomeCode} outcome
 * @property {string} accessToken
 * @property {number} accessTokenExpiresInSeconds
 * @property {string} refreshToken
 * @property {AuthUserSummary} user
 * @property {string} [emailHash]
 */

/**
 * Builds the public user summary for auth responses.
 * @param {import('mongoose').Document} user User document.
 * @param {string[]} roleIds Role id strings.
 * @returns {AuthUserSummary}
 */
function toUserSummary(user, roleIds) {
  return {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName,
    orgId: String(user.orgId),
    roleIds,
    mustChangePassword: user.mustChangePassword === true,
  };
}

/**
 * Loads role ids for a user membership; empty when missing.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @returns {Promise<string[]>}
 */
async function loadRoleIds(orgId, userId) {
  const membership = await findMembership(orgId, userId);
  if (!membership?.roleIds?.length) {
    return [];
  }
  return membership.roleIds.map((id) => String(id));
}

/**
 * Issues access + refresh tokens and persists the refresh session.
 * @param {object} deps
 * @param {(claims: object) => string} deps.signAccessToken
 * @param {import('mongoose').Document} deps.user
 * @param {string[]} deps.roleIds
 * @returns {Promise<AuthSuccessPayload>}
 */
async function issueAuthSuccess({ signAccessToken, user, roleIds }) {
  const refreshToken = mintRefreshToken();
  const session = await createSession({
    orgId: user.orgId,
    userId: user._id,
    refreshTokenHash: hashRefreshToken(refreshToken),
  });
  const accessToken = signAccessToken({
    sub: String(user._id),
    org: String(user.orgId),
    rls: roleIds,
    sid: String(session._id),
  });
  return {
    outcome: 'authenticated',
    accessToken,
    accessTokenExpiresInSeconds: JWT_ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    user: toUserSummary(user, roleIds),
  };
}

/**
 * Creates an auth service bound to a JWT signing secret.
 * @param {string} jwtSecret Access-token signing secret.
 */
export function createAuthService(jwtSecret) {
  const { signAccessToken, verifyAccessToken } = createTokenService(jwtSecret);

  /**
   * Attempts email/password login.
   * @param {{ email: string, password: string }} input Credentials.
   * @param {{ log?: { info?: Function } }} [ctx] Optional logger for internal outcomes.
   * @returns {Promise<AuthSuccessPayload | { outcome: AuthOutcomeCode, emailHash: string }>}
   */
  async function login(input, ctx = {}) {
    const emailHash = hashEmailForLog(input.email);
    const users = await findActiveUsersByEmailWithPassword(input.email);
    const dummyHash = await getDummyPasswordHash();

    if (users.length !== 1) {
      await verifyPassword(dummyHash, input.password);
      ctx.log?.info?.({ outcome: 'invalid_credentials', emailHash }, 'auth login rejected');
      return { outcome: 'invalid_credentials', emailHash };
    }

    const user = users[0];
    if (user.userStatus !== 'active' || !user.passwordHash) {
      await verifyPassword(user.passwordHash || dummyHash, input.password);
      ctx.log?.info?.({ outcome: 'invalid_credentials', emailHash }, 'auth login rejected');
      return { outcome: 'invalid_credentials', emailHash };
    }

    const matched = await verifyPassword(user.passwordHash, input.password);
    if (!matched) {
      ctx.log?.info?.({ outcome: 'invalid_credentials', emailHash }, 'auth login rejected');
      return { outcome: 'invalid_credentials', emailHash };
    }

    if (needsRehash(user.passwordHash)) {
      const nextHash = await hashPassword(input.password);
      await updateUserPasswordHash(user.orgId, user._id, nextHash);
      user.passwordHash = nextHash;
    }

    await touchLastLoginAt(user.orgId, user._id);
    const roleIds = await loadRoleIds(user.orgId, user._id);
    const success = await issueAuthSuccess({ signAccessToken, user, roleIds });
    ctx.log?.info?.({ outcome: 'authenticated', emailHash }, 'auth login succeeded');
    return { ...success, emailHash };
  }

  /**
   * Rotates a refresh token; detects reuse and revokes the family.
   * @param {string | undefined} refreshToken Opaque refresh token from cookie.
   * @param {{ log?: { info?: Function } }} [ctx] Optional logger.
   * @returns {Promise<AuthSuccessPayload | { outcome: AuthOutcomeCode }>}
   */
  async function refresh(refreshToken, ctx = {}) {
    if (!refreshToken) {
      return { outcome: 'session_expired' };
    }
    const tokenHash = hashRefreshToken(refreshToken);
    const current = await findSessionByRefreshTokenHash(tokenHash);
    if (!current) {
      return { outcome: 'session_expired' };
    }

    if (current.rotatedAt || current.revokedAt) {
      await revokeSessionFamily(current.familyId, 'reuse_detected');
      ctx.log?.info?.(
        { outcome: 'reuse_detected', familyId: current.familyId },
        'auth refresh reuse detected',
      );
      return { outcome: 'reuse_detected' };
    }

    if (!isSessionActiveForRefresh(current)) {
      return { outcome: 'session_expired' };
    }

    const user = await findUserById(current.orgId, current.userId);
    if (!user || user.userStatus !== 'active') {
      await revokeSessionFamily(current.familyId, 'user_disabled');
      return { outcome: 'session_expired' };
    }

    const nextRefreshToken = mintRefreshToken();
    const successor = await rotateSession(current, hashRefreshToken(nextRefreshToken));
    const roleIds = await loadRoleIds(user.orgId, user._id);
    const accessToken = signAccessToken({
      sub: String(user._id),
      org: String(user.orgId),
      rls: roleIds,
      sid: String(successor._id),
    });
    ctx.log?.info?.({ outcome: 'authenticated' }, 'auth refresh succeeded');
    return {
      outcome: 'authenticated',
      accessToken,
      accessTokenExpiresInSeconds: JWT_ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: nextRefreshToken,
      user: toUserSummary(user, roleIds),
    };
  }

  /**
   * Revokes the session for the presented refresh token. Always succeeds for the client.
   * @param {string | undefined} refreshToken Opaque refresh token.
   * @returns {Promise<{ outcome: 'authenticated' }>}
   */
  async function logout(refreshToken) {
    if (refreshToken) {
      const current = await findSessionByRefreshTokenHash(hashRefreshToken(refreshToken));
      if (current && !current.revokedAt) {
        await revokeSessionFamily(current.familyId, 'logout');
      } else if (current) {
        await revokeSession(current._id, 'logout');
      }
    }
    return { outcome: 'authenticated' };
  }

  return {
    login,
    refresh,
    logout,
    verifyAccessToken,
    signAccessToken,
  };
}
