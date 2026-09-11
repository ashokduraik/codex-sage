/**
 * Unit tests for the authenticate preHandler.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatePreHandler } from './authenticate.preHandler.js';

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
});
