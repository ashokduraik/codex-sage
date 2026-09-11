/**
 * Unit tests for the authenticate preHandler.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatePreHandler } from './authenticate.preHandler.js';

vi.mock('../identity/user.repository.js', () => ({
  findUserById: vi.fn(),
}));
vi.mock('./session.repository.js', () => ({
  findSessionById: vi.fn(),
  isSessionActiveForAccess: vi.fn(),
}));

import { findUserById } from '../identity/user.repository.js';
import { findSessionById, isSessionActiveForAccess } from './session.repository.js';

describe('authenticate.preHandler', () => {
  it('rejects missing or empty Bearer tokens as UNAUTHENTICATED', async () => {
    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: vi.fn(),
    });
    await expect(authenticate({ headers: {} }, {})).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      authenticate({ headers: { authorization: 'Bearer ' } }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('maps verify SESSION_EXPIRED and other verify failures', async () => {
    const expired = createAuthenticatePreHandler({
      verifyAccessToken: () => {
        const err = new Error('expired');
        err.code = 'SESSION_EXPIRED';
        throw err;
      },
    });
    await expect(
      expired({ headers: { authorization: 'Bearer tok' } }, {}),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    const bad = createAuthenticatePreHandler({
      verifyAccessToken: () => {
        throw new Error('bad');
      },
    });
    await expect(
      bad({ headers: { authorization: 'Bearer tok' } }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects with PASSWORD_CHANGE_REQUIRED when flag is set and route is not allowlisted', async () => {
    findUserById.mockResolvedValue({
      _id: 'u1',
      orgId: 'o1',
      userStatus: 'active',
      mustChangePassword: true,
      passwordUpdatedAt: null,
    });
    findSessionById.mockResolvedValue({
      _id: 's1',
      userId: 'u1',
      orgId: 'o1',
    });
    isSessionActiveForAccess.mockReturnValue(true);

    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: () => ({
        sub: 'u1',
        org: 'o1',
        sid: 's1',
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
    findSessionById.mockResolvedValue({
      _id: 's1',
      userId: 'u1',
      orgId: 'o1',
    });
    isSessionActiveForAccess.mockReturnValue(true);

    const authenticate = createAuthenticatePreHandler({
      verifyAccessToken: () => ({
        sub: 'u1',
        org: 'o1',
        sid: 's1',
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
});
