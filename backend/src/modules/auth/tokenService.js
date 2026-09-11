/**
 * Access JWT and opaque refresh-token helpers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createSigner, createVerifier, TokenError } from 'fast-jwt';

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
 * @property {string} sid Session id.
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
   * @param {{ sub: string, org: string, rls: string[], sid: string }} claims Identity claims.
   * @returns {string} Compact JWT.
   */
  function signAccessToken(claims) {
    return signer({
      sub: claims.sub,
      org: claims.org,
      rls: claims.rls,
      sid: claims.sid,
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

/**
 * SHA-256 hex digest of a normalized email for safe log fields.
 * @param {string} email Email address.
 * @returns {string}
 */
export function hashEmailForLog(email) {
  return createHash('sha256')
    .update(String(email).toLowerCase().trim(), 'utf8')
    .digest('hex');
}
