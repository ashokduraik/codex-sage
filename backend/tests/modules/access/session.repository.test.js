/**
 * Session repository integration tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUTH_MODELS } from '../../../src/modules/access/auth.js';
import {
  createSession,
  findSessionByRefreshTokenHash,
  isSessionActiveForAccess,
  isSessionActiveForRefresh,
  revokeSessionFamily,
  rotateSession,
} from '../../../src/modules/access/auth.js';
import { hashRefreshToken, mintRefreshToken } from '../../../src/modules/access/auth.js';

const harness = createMongoHarness({
  models: [...AUTH_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('session.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('creates a session and finds it by refresh-token hash only', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const refresh = mintRefreshToken();
    const created = await createSession({
      orgId,
      userId,
      refreshTokenHash: hashRefreshToken(refresh),
    });
    expect(isSessionActiveForRefresh(created)).toBe(true);
    const found = await findSessionByRefreshTokenHash(hashRefreshToken(refresh));
    expect(found?._id.toString()).toBe(created._id.toString());
    expect(found).not.toHaveProperty('refreshToken');
  });

  it('rotates a session and treats reuse as family revocation', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const firstToken = mintRefreshToken();
    const first = await createSession({
      orgId,
      userId,
      refreshTokenHash: hashRefreshToken(firstToken),
    });
    const secondToken = mintRefreshToken();
    const second = await rotateSession(first, hashRefreshToken(secondToken));
    const rotated = await findSessionByRefreshTokenHash(hashRefreshToken(firstToken));
    expect(rotated?.rotatedAt).toBeTruthy();
    expect(isSessionActiveForRefresh(rotated)).toBe(false);
    expect(isSessionActiveForAccess(rotated)).toBe(true);
    expect(isSessionActiveForRefresh(second)).toBe(true);

    await revokeSessionFamily(first.familyId, 'reuse_detected');
    const afterReuse = await findSessionByRefreshTokenHash(hashRefreshToken(secondToken));
    expect(afterReuse?.revokedAt).toBeTruthy();
    expect(isSessionActiveForAccess(afterReuse)).toBe(false);
  });
});
