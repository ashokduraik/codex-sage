/**
 * Auth HTTP routes — login, refresh, logout, me.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { resolveEffectivePermissions } from '../authorization/permissionResolver.js';
import { findMembership } from '../identity/membership.repository.js';
import { findUserById } from '../identity/user.repository.js';
import {
  JWT_ACCESS_TOKEN_TTL_SECONDS,
  JWT_REFRESH_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from './tokenService.js';

/** Readable CSRF cookie the browser echoes as `X-CSRF-Token` (D14). */
export const CSRF_COOKIE_NAME = 'csrfToken';

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
 * Cookie options for the readable CSRF double-submit cookie.
 * @param {boolean} isProduction Whether Secure should be set.
 * @returns {object}
 */
function csrfCookieOptions(isProduction) {
  return {
    path: REFRESH_COOKIE_PATH,
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
  const csrfToken = reply.generateCsrf();
  reply.setCookie(CSRF_COOKIE_NAME, csrfToken, {
    ...csrfCookieOptions(isProduction),
    maxAge: JWT_REFRESH_TOKEN_TTL_SECONDS,
  });
}

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
      config: { routeAccess: 'public', rateLimitClass: 'auth' },
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
        accessTokenExpiresInSeconds:
          result.accessTokenExpiresInSeconds ?? JWT_ACCESS_TOKEN_TTL_SECONDS,
        user: result.user,
      };
    },
  );

  app.post(
    '/auth/refresh',
    {
      config: { routeAccess: 'public', rateLimitClass: 'auth' },
      onRequest: app.csrfProtection,
    },
    async (request, reply) => {
      const result = await authService.refresh(readRefreshToken(request), {
        log: request.log,
      });
      if (result.outcome !== 'authenticated') {
        clearAuthCookies(reply, isProduction);
        throwForAuthOutcome(result.outcome);
      }
      setAuthCookies(reply, result.refreshToken, isProduction);
      return {
        accessToken: result.accessToken,
        accessTokenExpiresInSeconds:
          result.accessTokenExpiresInSeconds ?? JWT_ACCESS_TOKEN_TTL_SECONDS,
        user: result.user,
      };
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { routeAccess: 'public', rateLimitClass: 'auth' },
      onRequest: app.csrfProtection,
    },
    async (request, reply) => {
      await authService.logout(readRefreshToken(request));
      clearAuthCookies(reply, isProduction);
      return reply.status(204).send();
    },
  );

  app.get(
    '/auth/me',
    {
      config: {
        routeAccess: 'authenticated',
        rateLimitClass: 'auth',
        allowWhenMustChangePassword: true,
      },
    },
    async (request) => {
      const principal = request.principal;
      const user = await findUserById(principal.orgId, principal.userId);
      if (!user || user.userStatus !== 'active') {
        throw ApiError.fromCode('UNAUTHENTICATED');
      }
      const membership = await findMembership(principal.orgId, principal.userId);
      const roleIds = (membership?.roleIds ?? []).map((id) => String(id));
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
