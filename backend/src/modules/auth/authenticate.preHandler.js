/**
 * Fastify preHandler that resolves `request.principal` from a Bearer access token.
 */
import { ApiError } from '../../platform/errors.js';
import { findUserById } from '../identity/user.repository.js';
import {
  findSessionById,
  isSessionActiveForAccess,
} from './session.repository.js';

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

    const session = await findSessionById(claims.sid);
    if (!isSessionActiveForAccess(session)) {
      throw ApiError.fromCode('SESSION_EXPIRED');
    }
    if (String(session.userId) !== String(user._id) || String(session.orgId) !== String(user.orgId)) {
      throw ApiError.fromCode('UNAUTHENTICATED');
    }

    /** @type {RequestPrincipal} */
    request.principal = {
      userId: String(user._id),
      orgId: String(user.orgId),
      roleIds: claims.rls.map(String),
      sessionId: String(session._id),
    };
  };
}
