/**
 * Session repository — create, rotate, revoke refresh-token rows.
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { Session } from './session.model.js';
import { JWT_REFRESH_TOKEN_TTL_SECONDS } from './tokenService.js';

/**
 * Creates a new login session (start of a refresh-token family).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   userId: import('mongoose').Types.ObjectId | string,
 *   refreshTokenHash: string,
 *   familyId?: string,
 *   expiresAt?: Date,
 * }} input Session fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createSession(input, options = {}) {
  assertOrgId(input.orgId);
  const now = new Date();
  const expiresAt =
    input.expiresAt ??
    new Date(now.getTime() + JWT_REFRESH_TOKEN_TTL_SECONDS * 1000);
  const [doc] = await Session.create(
    [
      {
        orgId: input.orgId,
        userId: input.userId,
        familyId: input.familyId ?? randomUUID(),
        refreshTokenHash: input.refreshTokenHash,
        issuedAt: now,
        expiresAt,
        createdBy: input.userId,
        updatedBy: input.userId,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return doc;
}

/**
 * Finds an active session by refresh-token hash.
 * @param {string} refreshTokenHash SHA-256 hex of the opaque token.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findSessionByRefreshTokenHash(refreshTokenHash) {
  return Session.findOne({ refreshTokenHash }).exec();
}

/**
 * Finds a session by id (active rows only by default).
 * @param {import('mongoose').Types.ObjectId | string} sessionId Session id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findSessionById(sessionId) {
  return Session.findOne({ _id: sessionId }).exec();
}

/**
 * True when a session may still authorize Bearer access (`sid` check).
 * Rotated rows remain usable for residual access TTL until revoked/expired.
 * @param {import('mongoose').Document | null | undefined} session Session document.
 * @returns {boolean}
 */
export function isSessionActiveForAccess(session) {
  if (!session) {
    return false;
  }
  if (session.status !== ROW_STATUS_ACTIVE) {
    return false;
  }
  if (session.revokedAt) {
    return false;
  }
  if (!(session.expiresAt instanceof Date) || session.expiresAt.getTime() <= Date.now()) {
    return false;
  }
  return true;
}

/**
 * True when a session may be presented for refresh (not yet rotated or revoked).
 * @param {import('mongoose').Document | null | undefined} session Session document.
 * @returns {boolean}
 */
export function isSessionActiveForRefresh(session) {
  if (!isSessionActiveForAccess(session)) {
    return false;
  }
  return !session.rotatedAt;
}

/**
 * Rotates a session: marks the current row rotated and inserts a successor in the family.
 * @param {import('mongoose').Document} currentSession Current session document.
 * @param {string} nextRefreshTokenHash Hash of the newly minted refresh token.
 * @returns {Promise<import('mongoose').Document>} The successor session.
 */
export async function rotateSession(currentSession, nextRefreshTokenHash) {
  const mongoSession = await mongoose.startSession();
  try {
    /** @type {import('mongoose').Document | undefined} */
    let successor;
    await mongoSession.withTransaction(async () => {
      successor = await createSession(
        {
          orgId: currentSession.orgId,
          userId: currentSession.userId,
          familyId: currentSession.familyId,
          refreshTokenHash: nextRefreshTokenHash,
          expiresAt: currentSession.expiresAt,
        },
        { session: mongoSession },
      );
      await Session.updateOne(
        {
          _id: currentSession._id,
          status: ROW_STATUS_ACTIVE,
          $or: [{ rotatedAt: null }, { rotatedAt: { $exists: false } }],
        },
        {
          $set: {
            rotatedAt: new Date(),
            replacedBySessionId: successor._id,
            updatedBy: currentSession.userId,
            updatedAt: new Date(),
          },
        },
        { session: mongoSession },
      );
    });
    if (!successor) {
      throw new Error('Session rotation failed to create successor');
    }
    return successor;
  } finally {
    await mongoSession.endSession();
  }
}

/**
 * Revokes a single session (logout).
 * @param {import('mongoose').Types.ObjectId | string} sessionId Session id.
 * @param {'logout' | 'reuse_detected' | 'password_changed' | 'user_disabled'} reason Revocation reason.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function revokeSession(sessionId, reason) {
  return Session.updateOne(
    { _id: sessionId, status: ROW_STATUS_ACTIVE, revokedAt: null },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: reason,
        updatedAt: new Date(),
      },
    },
  );
}

/**
 * Revokes every session in a refresh-token family (reuse detection).
 * @param {string} familyId Family id shared by rotations of one login.
 * @param {'reuse_detected' | 'logout' | 'password_changed' | 'user_disabled'} reason Reason.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function revokeSessionFamily(familyId, reason) {
  return Session.updateMany(
    { familyId, status: ROW_STATUS_ACTIVE, revokedAt: null },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: reason,
        updatedAt: new Date(),
      },
    },
  );
}

/**
 * Revokes all active sessions for a user (password change / disable).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {'password_changed' | 'user_disabled' | 'logout'} reason Reason.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function revokeAllSessionsForUser(orgId, userId, reason, options = {}) {
  assertOrgId(orgId);
  const query = Session.updateMany(
    { orgId, userId, status: ROW_STATUS_ACTIVE, revokedAt: null },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: reason,
        updatedAt: new Date(),
      },
    },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}
