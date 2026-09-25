/**
 * Unit tests for access/refresh token helpers.
 */
import { describe, expect, it } from 'vitest';
import { TEST_JWT_ACCESS_TOKEN_SECRET } from '../../appConfig.js';
import {
  createTokenService,
  hashRefreshToken,
  JWT_AUDIENCE,
  JWT_ISSUER,
  mintRefreshToken,
} from '../../../src/modules/access/auth.js';

describe('tokenService', () => {
  const tokens = createTokenService(TEST_JWT_ACCESS_TOKEN_SECRET);

  it('signs access tokens with sub, org, rls, sid, iss, aud and no permissions', () => {
    const jwt = tokens.signAccessToken({
      sub: 'u1',
      org: 'o1',
      rls: ['r1'],
      sid: 's1',
    });
    const claims = tokens.verifyAccessToken(jwt);
    expect(claims.sub).toBe('u1');
    expect(claims.org).toBe('o1');
    expect(claims.rls).toEqual(['r1']);
    expect(claims.sid).toBe('s1');
    expect(claims.typ).toBe('access');
    expect(claims.iss).toBe(JWT_ISSUER);
    expect(claims.aud).toBe(JWT_AUDIENCE);
    expect(claims).not.toHaveProperty('permissions');
  });

  it('rejects a wrong signature, wrong issuer, wrong audience, and expired tokens', async () => {
    const other = createTokenService(`${TEST_JWT_ACCESS_TOKEN_SECRET}-other-key!!`);
    const jwt = tokens.signAccessToken({
      sub: 'u1',
      org: 'o1',
      rls: [],
      sid: 's1',
    });
    try {
      other.verifyAccessToken(jwt);
      expect.unreachable('expected wrong signature to fail');
    } catch (err) {
      expect(err.code).toBe('UNAUTHENTICATED');
    }

    const { createSigner } = await import('fast-jwt');
    const badIss = createSigner({
      key: TEST_JWT_ACCESS_TOKEN_SECRET,
      algorithm: 'HS256',
      iss: 'other-issuer',
      aud: JWT_AUDIENCE,
      expiresIn: 60_000,
    });
    try {
      tokens.verifyAccessToken(badIss({ sub: 'u1', org: 'o1', rls: [], sid: 's1', typ: 'access' }));
      expect.unreachable('expected wrong issuer to fail');
    } catch (err) {
      expect(err.code).toBe('UNAUTHENTICATED');
    }

    const badAud = createSigner({
      key: TEST_JWT_ACCESS_TOKEN_SECRET,
      algorithm: 'HS256',
      iss: JWT_ISSUER,
      aud: 'other-audience',
      expiresIn: 60_000,
    });
    try {
      tokens.verifyAccessToken(badAud({ sub: 'u1', org: 'o1', rls: [], sid: 's1', typ: 'access' }));
      expect.unreachable('expected wrong audience to fail');
    } catch (err) {
      expect(err.code).toBe('UNAUTHENTICATED');
    }

    const expiredSigner = createSigner({
      key: TEST_JWT_ACCESS_TOKEN_SECRET,
      algorithm: 'HS256',
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      expiresIn: 1,
    });
    const expired = expiredSigner({
      sub: 'u1',
      org: 'o1',
      rls: [],
      sid: 's1',
      typ: 'access',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      tokens.verifyAccessToken(expired);
      expect.unreachable('expected expired token to fail');
    } catch (err) {
      expect(err.code).toBe('SESSION_EXPIRED');
    }
  });

  it('mints unique refresh tokens and stores only a hash', () => {
    const values = new Set();
    for (let i = 0; i < 50; i += 1) {
      values.add(mintRefreshToken());
    }
    expect(values.size).toBe(50);
    const token = mintRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(token);
  });
});
