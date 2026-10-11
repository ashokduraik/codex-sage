/**
 * Unit tests for the authenticate preHandler.
 */
import { describe, expect, it, vi } from 'vitest';
import { LoginSession } from '../../../src/models/loginSession.model.js';
import { createAuthenticatePreHandler } from '../../../src/modules/access/auth.js';

vi.mock('../../../src/modules/masters/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findUserById: vi.fn(),
  };
});

import { findUserById } from '../../../src/modules/masters/index.js';

/**
 * @param {object} loginSession Login-session fields.
 * @returns {void}
 */
function mockLoginSession(loginSession) {
  vi.spyOn(LoginSession, 'findOne').mockReturnValue({
    exec: vi.fn().mockResolvedValue(loginSession),
  });
}

describe('authenticate.preHandler', () => {
  it('rejects missing or empty Bearer tokens as UNAUTHENTICATED', async () => {
    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: vi.fn(),
    });
    await expect(authenticate({ headers: {} }, {})).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(authenticate({ headers: { authorization: 'Bearer ' } }, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('maps verify SESSION_EXPIRED and other verify failures', async () => {
    const expired = createAuthenticatePreHandler({
      verifyAccessToken: () => {
        const err = new Error('expired');
        err.code = 'SESSION_EXPIRED';
        throw err;
      },
    });
    await expect(expired({ headers: { authorization: 'Bearer tok' } }, {})).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    const bad = createAuthenticatePreHandler({
      verifyAccessToken: () => {
        throw new Error('bad');
      },
    });
    await expect(bad({ headers: { authorization: 'Bearer tok' } }, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects with PASSWORD_CHANGE_REQUIRED when flag is set and route is not allowlisted', async () => {
    findUserById.mockResolvedValue({
      _id: 'u1',
      orgId: 'o1',
      userStatus: 'active',
      mustChangePassword: true,
      passwordUpdatedAt: null,
    });
    mockLoginSession({
      _id: 's1',
      userId: 'u1',
      orgId: 'o1',
      status: 'A',
      revokedAt: null,
      loggedOutAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: () => ({
        sub: 'u1',
        org: 'o1',
        sid: 's1',
        tid: 't1',
        rls: [],
        iat: Math.floor(Date.now() / 1000),
      }),
    });

    await expect(
      authenticate(
        {
          headers: { authorization: 'Bearer tok' },
          routeOptions: { config: {} },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('allows mustChangePassword when route config opts in', async () => {
    findUserById.mockResolvedValue({
      _id: 'u1',
      orgId: 'o1',
      userStatus: 'active',
      mustChangePassword: true,
      passwordUpdatedAt: null,
    });
    mockLoginSession({
      _id: 's1',
      userId: 'u1',
      orgId: 'o1',
      status: 'A',
      revokedAt: null,
      loggedOutAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: () => ({
        sub: 'u1',
        org: 'o1',
        sid: 's1',
        tid: 't-old',
        rls: ['r1'],
        iat: Math.floor(Date.now() / 1000),
      }),
    });

    const request = {
      headers: { authorization: 'Bearer tok' },
      routeOptions: { config: { allowWhenMustChangePassword: true } },
    };
    await authenticate(request, {});
    expect(request.principal).toEqual({
      userId: 'u1',
      orgId: 'o1',
      roleIds: ['r1'],
      sessionId: 's1',
    });
  });

  it('allows residual access after rotate when the login is still open', async () => {
    findUserById.mockResolvedValue({
      _id: 'u1',
      orgId: 'o1',
      userStatus: 'active',
      mustChangePassword: false,
      passwordUpdatedAt: null,
    });
    mockLoginSession({
      _id: 's1',
      userId: 'u1',
      orgId: 'o1',
      status: 'A',
      revokedAt: null,
      loggedOutAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      tokens: [
        { _id: 't-old', refreshTokenHash: 'h1', rotatedAt: new Date() },
        { _id: 't-new', refreshTokenHash: 'h2' },
      ],
    });

    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: () => ({
        sub: 'u1',
        org: 'o1',
        sid: 's1',
        tid: 't-old',
        rls: ['r1'],
        iat: Math.floor(Date.now() / 1000),
      }),
    });

    const request = {
      headers: { authorization: 'Bearer tok' },
      routeOptions: { config: {} },
    };
    await authenticate(request, {});
    expect(request.principal.sessionId).toBe('s1');
  });

  it('rejects access after logout or reuse revoke', async () => {
    findUserById.mockResolvedValue({
      _id: 'u1',
      orgId: 'o1',
      userStatus: 'active',
      mustChangePassword: false,
      passwordUpdatedAt: null,
    });
    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: () => ({
        sub: 'u1',
        org: 'o1',
        sid: 's1',
        tid: 't1',
        rls: [],
        iat: Math.floor(Date.now() / 1000),
      }),
    });

    mockLoginSession({
      _id: 's1',
      userId: 'u1',
      orgId: 'o1',
      status: 'A',
      revokedAt: null,
      loggedOutAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(authenticate({ headers: { authorization: 'Bearer tok' }, routeOptions: { config: {} } }, {})).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });

    mockLoginSession({
      _id: 's1',
      userId: 'u1',
      orgId: 'o1',
      status: 'A',
      revokedAt: new Date(),
      revokedReason: 'reuse_detected',
      loggedOutAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(authenticate({ headers: { authorization: 'Bearer tok' }, routeOptions: { config: {} } }, {})).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });
});
