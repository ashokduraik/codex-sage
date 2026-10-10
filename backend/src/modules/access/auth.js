/**
 * access/auth.js — merged resource file.
 */
import { LoginSession } from '../../models/loginSession.model.js';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { findUserById, findActiveUsersByEmailWithPassword, touchLastLoginAt, updateUserPasswordHash } from '../masters/index.js';
import { resolveEffectivePermissions } from './permissions.js';
import argon2 from 'argon2';
import { createSigner, createVerifier, TokenError } from 'fast-jwt';
import mongoose from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// --- from auth/passwordHasher.js ---
/**
 * argon2id password hashing — the only module that imports `argon2`.
 * Cost parameters are named constants (not env).
 */
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

// --- from auth/tokenService.js ---
/**
 * Access JWT and opaque refresh-token helpers.
 */
/** Access-token lifetime in seconds (15 minutes). */
export const JWT_ACCESS_TOKEN_TTL_SECONDS = 900;
/** Refresh-token absolute lifetime in seconds (1 day). */
export const JWT_REFRESH_TOKEN_TTL_SECONDS = 86_400;
/** JWT issuer claim verified on every request. */
export const JWT_ISSUER = 'codex-sage';
/** JWT audience claim verified on every request. */
export const JWT_AUDIENCE = 'codex-sage-api';
/** Opaque refresh cookie name. */
export const REFRESH_COOKIE_NAME = 'refreshToken';
/** Cookie path limited to auth routes (D14). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
/** Readable CSRF cookie the browser echoes as `X-CSRF-Token` (D14). */
export const CSRF_COOKIE_NAME = 'csrfToken';
/**
 * httpOnly CSRF secret cookie written by `@fastify/csrf-protection`.
 * Path-limited like the refresh cookie; not readable by SPA JavaScript.
 */
export const CSRF_SECRET_COOKIE_NAME = '_csrf';
/**
 * Path for the readable double-submit cookie so `document.cookie` can read it from any
 * SPA route (`Path=/api/v1/auth` is invisible to pages outside that prefix).
 */
export const CSRF_READABLE_COOKIE_PATH = '/';

/**
 * @typedef {object} AccessTokenClaims
 * @property {string} sub User id.
 * @property {string} org Organization id.
 * @property {string[]} rls Role ids.
 * @property {string} sid Login-session id.
 * @property {string} tid Current refresh-token entry id.
 * @property {'access'} typ Token type.
 * @property {number} [iat] Issued-at (seconds).
 * @property {number} [exp] Expiry (seconds).
 */

/**
 * Creates sign/verify helpers bound to a secret.
 * @param {string} secret JWT signing secret.
 * @returns {{
 *   signAccessToken: (claims: Omit<AccessTokenClaims, 'typ' | 'iat' | 'exp'>) => string,
 *   verifyAccessToken: (token: string) => AccessTokenClaims,
 * }}
 */
export function createTokenService(secret) {
  const signer = createSigner({
    key: secret,
    algorithm: 'HS256',
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    expiresIn: JWT_ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  const verifier = createVerifier({
    key: secret,
    algorithms: ['HS256'],
    allowedIss: JWT_ISSUER,
    allowedAud: JWT_AUDIENCE,
  });

  /**
   * Signs a short-lived access JWT (role ids only — no permissions).
   * @param {{ sub: string, org: string, rls: string[], sid: string, tid: string }} claims Identity claims.
   * @returns {string} Compact JWT.
   */
  function signAccessToken(claims) {
    return signer({
      sub: claims.sub,
      org: claims.org,
      rls: claims.rls,
      sid: claims.sid,
      tid: claims.tid,
      typ: 'access',
    });
  }

  /**
   * Verifies an access token and returns its claims.
   * @param {string} token Compact JWT.
   * @returns {AccessTokenClaims}
   * @throws {{ code: 'SESSION_EXPIRED' | 'UNAUTHENTICATED' }} Mapped auth failure.
   */
  function verifyAccessToken(token) {
    try {
      const payload = verifier(token);
      if (
        !payload ||
        typeof payload !== 'object' ||
        payload.typ !== 'access' ||
        typeof payload.sub !== 'string' ||
        typeof payload.org !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.tid !== 'string' ||
        !Array.isArray(payload.rls)
      ) {
        const err = new Error('Invalid access token claims');
        err.code = 'UNAUTHENTICATED';
        throw err;
      }
      return /** @type {AccessTokenClaims} */ (payload);
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'UNAUTHENTICATED') {
        throw err;
      }
      if (err instanceof TokenError && err.code === TokenError.codes.expired) {
        const expired = new Error('Access token expired');
        expired.code = 'SESSION_EXPIRED';
        throw expired;
      }
      const unauth = new Error('Access token invalid');
      unauth.code = 'UNAUTHENTICATED';
      throw unauth;
    }
  }

  return { signAccessToken, verifyAccessToken };
}

/**
 * Mints a cryptographically random opaque refresh token (256 bits, base64url).
 * @returns {string}
 */
export function mintRefreshToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest of a refresh token (never store the raw value).
 * @param {string} refreshToken Opaque refresh token.
 * @returns {string}
 */
export function hashRefreshToken(refreshToken) {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
}

// --- from auth/session.repository.js ---
/**
 * Login-session repository — one document per sign-in, tokens embedded.
 */
/**
 * Creates a new login session with the first refresh-token entry.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   userId: import('mongoose').Types.ObjectId | string,
 *   refreshTokenHash: string,
 *   expiresAt?: Date,
 * }} input Login-session fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createLoginSession(input, options = {}) {
  assertOrgId(input.orgId);
  const now = new Date();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + JWT_REFRESH_TOKEN_TTL_SECONDS * 1000);
  const [doc] = await LoginSession.create(
    [
      {
        orgId: input.orgId,
        userId: input.userId,
        loggedInAt: now,
        expiresAt,
        tokens: [{ refreshTokenHash: input.refreshTokenHash, issuedAt: now }],
        createdBy: input.userId,
        updatedBy: input.userId,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return doc;
}

/**
 * Finds a login session by a refresh-token hash.
 * @param {string} refreshTokenHash SHA-256 hex of the opaque token.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findLoginSessionByRefreshTokenHash(refreshTokenHash) {
  return LoginSession.findOne({ 'tokens.refreshTokenHash': refreshTokenHash }).exec();
}

/**
 * Finds a login session by id (active rows only by default).
 * @param {import('mongoose').Types.ObjectId | string} loginSessionId Login-session id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findLoginSessionById(loginSessionId) {
  return LoginSession.findOne({ _id: loginSessionId }).exec();
}

/**
 * True when a login may still authorize Bearer access (`sid` check).
 * Residual access tokens stay valid after rotate until logout, revoke, or expiry.
 * @param {import('mongoose').Document | null | undefined} loginSession Login document.
 * @returns {boolean}
 */
export function isLoginSessionActiveForAccess(loginSession) {
  if (!loginSession) {
    return false;
  }
  if (loginSession.status !== ROW_STATUS_ACTIVE) {
    return false;
  }
  if (loginSession.loggedOutAt) {
    return false;
  }
  if (loginSession.revokedAt) {
    return false;
  }
  if (!(loginSession.expiresAt instanceof Date) || loginSession.expiresAt.getTime() <= Date.now()) {
    return false;
  }
  return true;
}

/**
 * True when the presented refresh hash may be rotated (parent open, entry unrotated).
 * @param {import('mongoose').Document | null | undefined} loginSession Login document.
 * @param {string} refreshTokenHash SHA-256 hex of the presented token.
 * @returns {boolean}
 */
export function isLoginSessionActiveForRefresh(loginSession, refreshTokenHash) {
  if (!isLoginSessionActiveForAccess(loginSession)) {
    return false;
  }
  const entry = findTokenEntryByHash(loginSession, refreshTokenHash);
  return Boolean(entry && !entry.rotatedAt);
}

/**
 * Rotates the presented refresh hash and appends the successor on the same login.
 * @param {import('mongoose').Document} loginSession Current login document.
 * @param {string} currentRefreshTokenHash Hash of the presented refresh token.
 * @param {string} nextRefreshTokenHash Hash of the newly minted refresh token.
 * @returns {Promise<import('mongoose').Document | null>} Updated login, or null when the
 *   presented hash was already rotated (caller treats as reuse).
 */
export async function rotateLoginSession(loginSession, currentRefreshTokenHash, nextRefreshTokenHash) {
  const now = new Date();
  const nextTokenId = new mongoose.Types.ObjectId();
  return LoginSession.findOneAndUpdate(
    {
      _id: loginSession._id,
      status: ROW_STATUS_ACTIVE,
      revokedAt: null,
      loggedOutAt: null,
      tokens: {
        $elemMatch: {
          refreshTokenHash: currentRefreshTokenHash,
          rotatedAt: null,
        },
      },
    },
    [
      {
        $set: {
          tokens: {
            $concatArrays: [
              {
                $map: {
                  input: '$tokens',
                  as: 'entry',
                  in: {
                    $cond: [
                      { $eq: ['$$entry.refreshTokenHash', currentRefreshTokenHash] },
                      { $mergeObjects: ['$$entry', { rotatedAt: now }] },
                      '$$entry',
                    ],
                  },
                },
              },
              [
                {
                  _id: nextTokenId,
                  refreshTokenHash: nextRefreshTokenHash,
                  issuedAt: now,
                },
              ],
            ],
          },
          updatedBy: loginSession.userId,
          updatedAt: now,
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();
}

/**
 * Ends one login: logout sets `loggedOutAt`; other reasons set `revokedAt`.
 * @param {import('mongoose').Types.ObjectId | string} loginSessionId Login-session id.
 * @param {'logout' | 'reuse_detected' | 'password_changed' | 'user_disabled' | 'email_changed'} reason Why the login ended.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function revokeLoginSession(loginSessionId, reason) {
  const now = new Date();
  const filter = {
    _id: loginSessionId,
    status: ROW_STATUS_ACTIVE,
    revokedAt: null,
    loggedOutAt: null,
  };
  const $set = reason === 'logout' ? { loggedOutAt: now, updatedAt: now } : { revokedAt: now, revokedReason: reason, updatedAt: now };
  return LoginSession.updateOne(filter, { $set });
}

/**
 * Revokes all open logins for a user (password change / disable / email change).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {'password_changed' | 'user_disabled' | 'email_changed'} reason Reason.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function revokeAllLoginSessionsForUser(orgId, userId, reason, options = {}) {
  assertOrgId(orgId);
  const now = new Date();
  const query = LoginSession.updateMany(
    {
      orgId,
      userId,
      status: ROW_STATUS_ACTIVE,
      revokedAt: null,
      loggedOutAt: null,
    },
    {
      $set: {
        revokedAt: now,
        revokedReason: reason,
        updatedAt: now,
      },
    },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

// --- from auth/authenticate.preHandler.js ---
/**
 * Fastify preHandler that resolves `request.principal` from a Bearer access token.
 */
/**
 * @typedef {object} RequestPrincipal
 * @property {string} userId
 * @property {string} orgId
 * @property {string[]} roleIds
 * @property {string} sessionId
 */

/**
 * Builds the authenticate preHandler bound to a token verifier.
 * @param {{ verifyAccessToken: (token: string) => object }} tokenService Token verifier.
 * @returns {(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 */
export function createAuthenticatePreHandler(tokenService) {
  /**
   * Verifies the Bearer token, loads the user and session, and sets `request.principal`.
   * @param {import('fastify').FastifyRequest} request Incoming request.
   * @param {import('fastify').FastifyReply} _reply Reply (unused; errors are thrown).
   * @returns {Promise<void>}
   */
  return async function authenticate(request, _reply) {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw ApiError.fromCode('UNAUTHENTICATED');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw ApiError.fromCode('UNAUTHENTICATED');
    }

    let claims;
    try {
      claims = tokenService.verifyAccessToken(token);
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'SESSION_EXPIRED') {
        throw ApiError.fromCode('SESSION_EXPIRED');
      }
      throw ApiError.fromCode('UNAUTHENTICATED');
    }

    const user = await findUserById(claims.org, claims.sub);
    if (!user || user.userStatus !== 'active') {
      throw ApiError.fromCode('UNAUTHENTICATED');
    }

    if (
      user.passwordUpdatedAt instanceof Date &&
      typeof claims.iat === 'number' &&
      Math.floor(user.passwordUpdatedAt.getTime() / 1000) > claims.iat
    ) {
      throw ApiError.fromCode('SESSION_EXPIRED');
    }

    const loginSession = await findLoginSessionById(claims.sid);
    if (!isLoginSessionActiveForAccess(loginSession)) {
      throw ApiError.fromCode('SESSION_EXPIRED');
    }
    if (String(loginSession.userId) !== String(user._id) || String(loginSession.orgId) !== String(user.orgId)) {
      throw ApiError.fromCode('UNAUTHENTICATED');
    }

    const allowWhenMustChange = request.routeOptions?.config?.allowWhenMustChangePassword === true;
    if (user.mustChangePassword === true && !allowWhenMustChange) {
      throw ApiError.fromCode('PASSWORD_CHANGE_REQUIRED');
    }

    /** @type {RequestPrincipal} */
    request.principal = {
      userId: String(user._id),
      orgId: String(user.orgId),
      roleIds: claims.rls.map(String),
      sessionId: String(loginSession._id),
    };
  };
}

// --- from auth/auth.service.js ---
/**
 * Auth service — login, refresh, logout as typed outcomes (Phase 10 audit hook).
 */
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
 * Loads role ids for a user; empty when missing.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @returns {Promise<string[]>}
 */
async function loadRoleIds(orgId, userId) {
  const user = await findUserById(orgId, userId);
  if (!user?.roleIds?.length) {
    return [];
  }
  return user.roleIds.map((id) => String(id));
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
    const emailHash = createHash('sha256').update(String(input.email).toLowerCase().trim(), 'utf8').digest('hex');
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

    let nextHash;
    if (needsRehash(user.passwordHash)) {
      nextHash = await hashPassword(input.password);
      user.passwordHash = nextHash;
    }

    const roleIds = await loadRoleIds(user.orgId, user._id);
    const mongoSession = await mongoose.startSession();
    /** @type {AuthSuccessPayload | undefined} */
    let success;
    try {
      await mongoSession.withTransaction(async () => {
        if (nextHash) {
          await updateUserPasswordHash(user.orgId, user._id, nextHash, {
            session: mongoSession,
          });
        }
        await touchLastLoginAt(user.orgId, user._id, { session: mongoSession });
        success = await issueAuthSuccess({
          signAccessToken,
          user,
          roleIds,
          session: mongoSession,
        });
      });
    } finally {
      await mongoSession.endSession();
    }
    if (!success) {
      throw new Error('Login transaction did not persist a session');
    }
    ctx.log?.info?.({ outcome: 'authenticated', emailHash }, 'auth login succeeded');
    return { ...success, emailHash };
  }

  /**
   * Rotates a refresh token; detects reuse and revokes the login.
   * @param {string | undefined} refreshToken Opaque refresh token from cookie.
   * @param {{ log?: { info?: Function } }} [ctx] Optional logger.
   * @returns {Promise<AuthSuccessPayload | { outcome: AuthOutcomeCode }>}
   */
  async function refresh(refreshToken, ctx = {}) {
    if (!refreshToken) {
      return { outcome: 'session_expired' };
    }
    const tokenHash = hashRefreshToken(refreshToken);
    const current = await findLoginSessionByRefreshTokenHash(tokenHash);
    if (!current) {
      return { outcome: 'session_expired' };
    }

    const presented = findTokenEntryByHash(current, tokenHash);
    if (presented?.rotatedAt || current.revokedAt || current.loggedOutAt) {
      await revokeLoginSession(current._id, 'reuse_detected');
      ctx.log?.info?.({ outcome: 'reuse_detected', loginSessionId: String(current._id) }, 'auth refresh reuse detected');
      return { outcome: 'reuse_detected' };
    }

    if (!isLoginSessionActiveForRefresh(current, tokenHash)) {
      return { outcome: 'session_expired' };
    }

    const user = await findUserById(current.orgId, current.userId);
    if (!user || user.userStatus !== 'active') {
      await revokeLoginSession(current._id, 'user_disabled');
      return { outcome: 'session_expired' };
    }

    const nextRefreshToken = mintRefreshToken();
    const nextHash = hashRefreshToken(nextRefreshToken);
    const rotated = await rotateLoginSession(current, tokenHash, nextHash);
    if (!rotated) {
      await revokeLoginSession(current._id, 'reuse_detected');
      ctx.log?.info?.({ outcome: 'reuse_detected', loginSessionId: String(current._id) }, 'auth refresh reuse detected');
      return { outcome: 'reuse_detected' };
    }
    const nextEntry = findTokenEntryByHash(rotated, nextHash);
    if (!nextEntry) {
      throw new Error('Login session missing rotated refresh token');
    }
    const roleIds = await loadRoleIds(user.orgId, user._id);
    const accessToken = signAccessToken({
      sub: String(user._id),
      org: String(user.orgId),
      rls: roleIds,
      sid: String(rotated._id),
      tid: String(nextEntry._id),
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
   * Ends the login for the presented refresh token. Always succeeds for the client.
   * @param {string | undefined} refreshToken Opaque refresh token.
   * @returns {Promise<{ outcome: 'authenticated' }>}
   */
  async function logout(refreshToken) {
    if (refreshToken) {
      const current = await findLoginSessionByRefreshTokenHash(hashRefreshToken(refreshToken));
      if (current && !current.revokedAt && !current.loggedOutAt) {
        await revokeLoginSession(current._id, 'logout');
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

  /**
   * Issues access + refresh tokens and persists the refresh session.
   * @param {object} deps
   * @param {(claims: object) => string} deps.signAccessToken
   * @param {import('mongoose').Document} deps.user
   * @param {string[]} deps.roleIds
   * @param {import('mongoose').ClientSession} [deps.session] Optional Mongo session.
   * @returns {Promise<AuthSuccessPayload>}
   */
  async function issueAuthSuccess({ signAccessToken, user, roleIds, session }) {
    const refreshToken = mintRefreshToken();
    const loginSession = await createLoginSession(
      {
        orgId: user.orgId,
        userId: user._id,
        refreshTokenHash: hashRefreshToken(refreshToken),
      },
      session ? { session } : {},
    );
    const tokenEntry = loginSession.tokens.find((entry) => !entry.rotatedAt);
    if (!tokenEntry) {
      throw new Error('Login session missing current refresh token');
    }
    const accessToken = signAccessToken({
      sub: String(user._id),
      org: String(user.orgId),
      rls: roleIds,
      sid: String(loginSession._id),
      tid: String(tokenEntry._id),
    });
    return {
      outcome: 'authenticated',
      accessToken,
      accessTokenExpiresInSeconds: JWT_ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      user: toUserSummary(user, roleIds),
    };
  }
}

// --- from auth/auth.routes.js ---
/**
 * Auth HTTP routes — login, refresh, logout, me.
 */
const loginBodySchema = z.object({
  // Accept product emails including `admin@localhost` (zod's email() rejects .localhost).
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .refine((value) => /^[^\s@]+@[^\s@]+$/.test(value), {
      message: 'Invalid email',
    }),
  password: z.string().min(1).max(1024),
});

/**
 * Maps auth service outcomes to API errors (never leaks internal reasons).
 * @param {string} outcome Auth service outcome code.
 * @throws {ApiError}
 */
function throwForAuthOutcome(outcome) {
  if (outcome === 'invalid_credentials' || outcome === 'not_permitted') {
    throw ApiError.fromCode('INVALID_CREDENTIALS');
  }
  if (outcome === 'reuse_detected' || outcome === 'session_expired') {
    throw ApiError.fromCode('SESSION_EXPIRED');
  }
  throw ApiError.fromCode('UNAUTHENTICATED');
}

/**
 * Reads the refresh token from the auth cookie.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {string | undefined}
 */
function readRefreshToken(request) {
  const value = request.cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Registers `/auth/*` routes on the Fastify instance (under API_BASE_PATH).
 * @param {import('fastify').FastifyInstance} app Fastify app with auth plugins decorated.
 */
export async function authRoutes(app) {
  const authService = app.authService;
  const isProduction = app.config.env.isProduction;

  app.post(
    '/auth/login',
    {
      config: { routeAccess: 'public' },
    },
    async (request, reply) => {
      const parsed = loginBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const result = await authService.login(parsed.data, { log: request.log });
      if (result.outcome !== 'authenticated') {
        throwForAuthOutcome(result.outcome);
      }
      setAuthCookies(reply, result.refreshToken, isProduction);
      return {
        accessToken: result.accessToken,
        accessTokenExpiresInSeconds: result.accessTokenExpiresInSeconds ?? JWT_ACCESS_TOKEN_TTL_SECONDS,
        user: result.user,
      };
    },
  );

  app.post(
    '/auth/refresh',
    {
      config: { routeAccess: 'public' },
      onRequest: app.csrfProtection,
    },
    async (request, reply) => {
      const refreshToken = readRefreshToken(request);
      const result = await authService.refresh(refreshToken, {
        log: request.log,
      });
      if (result.outcome !== 'authenticated') {
        clearAuthCookies(reply, isProduction);
        throwForAuthOutcome(result.outcome);
      }
      setAuthCookies(reply, result.refreshToken, isProduction);
      return {
        accessToken: result.accessToken,
        accessTokenExpiresInSeconds: result.accessTokenExpiresInSeconds ?? JWT_ACCESS_TOKEN_TTL_SECONDS,
        user: result.user,
      };
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { routeAccess: 'public' },
      onRequest: app.csrfProtection,
    },
    async (request, reply) => {
      const refreshToken = readRefreshToken(request);
      await authService.logout(refreshToken);
      clearAuthCookies(reply, isProduction);
      return reply.status(204).send();
    },
  );

  app.get(
    '/auth/me',
    {
      config: {
        routeAccess: 'authenticated',
        allowWhenMustChangePassword: true,
      },
    },
    async (request) => {
      const principal = request.principal;
      const user = await findUserById(principal.orgId, principal.userId);
      if (!user || user.userStatus !== 'active') {
        throw ApiError.fromCode('UNAUTHENTICATED');
      }
      const roleIds = (user.roleIds ?? []).map((id) => String(id));
      const permissions = await resolveEffectivePermissions(principal.orgId, roleIds);
      return {
        id: String(user._id),
        email: user.email,
        displayName: user.displayName,
        orgId: String(user.orgId),
        roleIds,
        permissions,
        mustChangePassword: user.mustChangePassword === true,
      };
    },
  );
}

/**
 * Finds the token entry matching a refresh-token hash.
 * @param {import('mongoose').Document | null | undefined} loginSession Login document.
 * @param {string} refreshTokenHash SHA-256 hex of the opaque token.
 * @returns {{ refreshTokenHash: string, issuedAt: Date, rotatedAt?: Date, _id: import('mongoose').Types.ObjectId } | undefined}
 */
function findTokenEntryByHash(loginSession, refreshTokenHash) {
  if (!loginSession?.tokens) {
    return undefined;
  }
  return loginSession.tokens.find((entry) => entry.refreshTokenHash === refreshTokenHash);
}

/**
 * Cookie options for the httpOnly refresh token (D14).
 * @param {boolean} isProduction Whether Secure should be set.
 * @returns {object}
 */
function refreshCookieOptions(isProduction) {
  return {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
  };
}

/**
 * Cookie options for the httpOnly CSRF secret (`_csrf`).
 * @param {boolean} isProduction Whether Secure should be set.
 * @returns {object}
 */
function csrfSecretCookieOptions(isProduction) {
  return {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
  };
}

/**
 * Cookie options for the readable CSRF double-submit cookie.
 * @param {boolean} isProduction Whether Secure should be set.
 * @returns {object}
 */
function csrfCookieOptions(isProduction) {
  return {
    path: CSRF_READABLE_COOKIE_PATH,
    httpOnly: false,
    sameSite: 'strict',
    secure: isProduction,
  };
}

/**
 * Clears auth cookies on the reply.
 * @param {import('fastify').FastifyReply} reply Reply.
 * @param {boolean} isProduction Production flag.
 */
function clearAuthCookies(reply, isProduction) {
  reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(isProduction));
  reply.clearCookie(CSRF_COOKIE_NAME, csrfCookieOptions(isProduction));
  // Also clear any pre-fix readable CSRF cookie that used the auth path.
  reply.clearCookie(CSRF_COOKIE_NAME, {
    ...csrfCookieOptions(isProduction),
    path: REFRESH_COOKIE_PATH,
  });
  reply.clearCookie(CSRF_SECRET_COOKIE_NAME, csrfSecretCookieOptions(isProduction));
}

/**
 * Sets the refresh cookie and readable CSRF cookie after login/refresh.
 * @param {import('fastify').FastifyReply} reply Reply.
 * @param {string} refreshToken Opaque refresh token.
 * @param {boolean} isProduction Production flag.
 */
function setAuthCookies(reply, refreshToken, isProduction) {
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...refreshCookieOptions(isProduction),
    maxAge: JWT_REFRESH_TOKEN_TTL_SECONDS,
  });
  // generateCsrf() skips Set-Cookie when the request already has `_csrf`; drop it so the
  // secret is re-issued with maxAge aligned to the refresh cookie.
  if (reply.request?.cookies) {
    delete reply.request.cookies[CSRF_SECRET_COOKIE_NAME];
  }
  const csrfToken = reply.generateCsrf({
    ...csrfSecretCookieOptions(isProduction),
    maxAge: JWT_REFRESH_TOKEN_TTL_SECONDS,
  });
  reply.setCookie(CSRF_COOKIE_NAME, csrfToken, {
    ...csrfCookieOptions(isProduction),
    maxAge: JWT_REFRESH_TOKEN_TTL_SECONDS,
  });
}

export { LoginSession } from '../../models/loginSession.model.js';
