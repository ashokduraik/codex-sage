/**
 * Login-session repository integration tests.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashRefreshToken, mintRefreshToken } from '../../../src/modules/access/auth.js';
import {
  createLoginSession,
  revokeLoginSession,
  rotateLoginSession,
  isLoginSessionActiveForAccess,
  revokeAllLoginSessionsForUser,
  isLoginSessionActiveForRefresh,
  findLoginSessionByRefreshTokenHash,
} from '../../../src/modules/access/auth.js';

const harness = createMongoHarness({
  models: [...AUTH_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('loginSession.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('creates a login session and finds it by refresh-token hash only', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const refresh = mintRefreshToken();
    const hash = hashRefreshToken(refresh);
    const created = await createLoginSession({
      orgId,
      userId,
      refreshTokenHash: hash,
    });
    expect(isLoginSessionActiveForRefresh(created, hash)).toBe(true);
    const found = await findLoginSessionByRefreshTokenHash(hash);
    expect(found?._id.toString()).toBe(created._id.toString());
    expect(found).not.toHaveProperty('refreshToken');
    expect(found.tokens).toHaveLength(1);
  });

  it('rotates a login session and treats reuse as login revocation', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const firstToken = mintRefreshToken();
    const firstHash = hashRefreshToken(firstToken);
    const first = await createLoginSession({
      orgId,
      userId,
      refreshTokenHash: firstHash,
    });
    const secondToken = mintRefreshToken();
    const secondHash = hashRefreshToken(secondToken);
    const rotated = await rotateLoginSession(first, firstHash, secondHash);
    expect(rotated?._id.toString()).toBe(first._id.toString());
    expect(rotated.tokens).toHaveLength(2);
    const firstEntry = rotated.tokens.find((entry) => entry.refreshTokenHash === firstHash);
    expect(firstEntry?.rotatedAt).toBeTruthy();
    expect(isLoginSessionActiveForRefresh(rotated, firstHash)).toBe(false);
    expect(isLoginSessionActiveForAccess(rotated)).toBe(true);
    expect(isLoginSessionActiveForRefresh(rotated, secondHash)).toBe(true);

    await revokeLoginSession(first._id, 'reuse_detected');
    const afterReuse = await findLoginSessionByRefreshTokenHash(secondHash);
    expect(afterReuse?.revokedAt).toBeTruthy();
    expect(afterReuse?.revokedReason).toBe('reuse_detected');
    expect(isLoginSessionActiveForAccess(afterReuse)).toBe(false);
  });

  it('sets loggedOutAt on logout and revokedAt on password-style revoke', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const logoutToken = mintRefreshToken();
    const logoutHash = hashRefreshToken(logoutToken);
    const logoutLogin = await createLoginSession({
      orgId,
      userId,
      refreshTokenHash: logoutHash,
    });
    await revokeLoginSession(logoutLogin._id, 'logout');
    const afterLogout = await findLoginSessionByRefreshTokenHash(logoutHash);
    expect(afterLogout?.loggedOutAt).toBeTruthy();
    expect(afterLogout?.revokedAt).toBeFalsy();
    expect(isLoginSessionActiveForAccess(afterLogout)).toBe(false);

    const revokeToken = mintRefreshToken();
    const revokeHash = hashRefreshToken(revokeToken);
    const revokeLogin = await createLoginSession({
      orgId,
      userId,
      refreshTokenHash: revokeHash,
    });
    await revokeLoginSession(revokeLogin._id, 'password_changed');
    const afterRevoke = await findLoginSessionByRefreshTokenHash(revokeHash);
    expect(afterRevoke?.revokedAt).toBeTruthy();
    expect(afterRevoke?.revokedReason).toBe('password_changed');
    expect(afterRevoke?.loggedOutAt).toBeFalsy();
    expect(isLoginSessionActiveForAccess(afterRevoke)).toBe(false);
  });

  it('rejects access when the login is missing, deleted, or expired', () => {
    expect(isLoginSessionActiveForAccess(null)).toBe(false);
    expect(
      isLoginSessionActiveForAccess({
        status: 'D',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBe(false);
    expect(
      isLoginSessionActiveForAccess({
        status: 'A',
        expiresAt: new Date(Date.now() - 1),
      }),
    ).toBe(false);
    expect(
      isLoginSessionActiveForRefresh(
        {
          status: 'A',
          expiresAt: new Date(Date.now() + 60_000),
          tokens: [{ refreshTokenHash: 'other' }],
        },
        'missing',
      ),
    ).toBe(false);
  });

  it('returns null when rotate races an already-rotated hash and revokes all user logins', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const firstHash = hashRefreshToken(mintRefreshToken());
    const created = await createLoginSession({
      orgId,
      userId,
      refreshTokenHash: firstHash,
    });
    const secondHash = hashRefreshToken(mintRefreshToken());
    await rotateLoginSession(created, firstHash, secondHash);
    const raced = await rotateLoginSession(created, firstHash, hashRefreshToken(mintRefreshToken()));
    expect(raced).toBeNull();

    await revokeAllLoginSessionsForUser(orgId, userId, 'email_changed');
    const after = await findLoginSessionByRefreshTokenHash(secondHash);
    expect(after?.revokedReason).toBe('email_changed');
  });
});
