/**
 * Public surface of the auth module.
 */
export {
  hashPassword,
  verifyPassword,
  needsRehash,
  getDummyPasswordHash,
  ARGON2_MEMORY_COST_KIB,
  ARGON2_TIME_COST,
  ARGON2_PARALLELISM,
} from './passwordHasher.js';
export {
  createTokenService,
  mintRefreshToken,
  hashRefreshToken,
  hashEmailForLog,
  JWT_ACCESS_TOKEN_TTL_SECONDS,
  JWT_REFRESH_TOKEN_TTL_SECONDS,
  JWT_ISSUER,
  JWT_AUDIENCE,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from './tokenService.js';
export { Session, SESSION_REVOKED_REASONS } from './session.model.js';
export {
  createSession,
  findSessionByRefreshTokenHash,
  findSessionById,
  isSessionActiveForAccess,
  isSessionActiveForRefresh,
  rotateSession,
  revokeSession,
  revokeSessionFamily,
  revokeAllSessionsForUser,
} from './session.repository.js';
export { createAuthService } from './auth.service.js';
export { createAuthenticatePreHandler } from './authenticate.preHandler.js';
export { authRoutes, CSRF_COOKIE_NAME } from './auth.routes.js';

import { Session } from './session.model.js';

/** Models whose indexes are synced on development API startup. */
export const AUTH_MODELS = Object.freeze([Session]);
