/**
 * Unit tests for password change route edge outcomes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/modules/masters/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findUserById: vi.fn(),
    findUserByIdWithPassword: vi.fn(),
    applyPasswordUpdate: vi.fn(),
  };
});

vi.mock('../../../src/modules/access/auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hashPassword: vi.fn(async () => 'hashed'),
    verifyPassword: vi.fn(),
    revokeAllLoginSessionsForUser: vi.fn(async () => ({})),
  };
});

vi.mock('../../../src/modules/access/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildAuditContextFromRequest: vi.fn(() => ({
      orgId: 'o1',
      actorUserId: 'u1',
      correlationId: 'REQ-unit',
      ip: undefined,
      userAgent: undefined,
    })),
    recordAuditEvent: vi.fn(async () => {}),
  };
});

import argon2 from 'argon2';
import { User } from '../../../src/models/user.model.js';
import { verifyPassword } from '../../../src/modules/access/auth.js';
import { recordAuditEvent } from '../../../src/modules/access/audit.js';
import { changeOwnPasswordHttp } from '../../../src/modules/access/password.js';

/**
 * @param {object | null} doc User document.
 * @returns {void}
 */
function mockUserLookup(doc) {
  vi.spyOn(User, 'findOne').mockReturnValue({
    select() {
      return this;
    },
    session() {
      return this;
    },
    exec: vi.fn().mockResolvedValue(doc),
  });
}

describe('password.routes edge outcomes', () => {
  it('maps not_found outcome to UNAUTHENTICATED', async () => {
    mockUserLookup({ passwordHash: null });
    await expect(
      changeOwnPasswordHttp(
        {
          id: 'REQ-unit',
          body: { currentPassword: 'abcdef', newPassword: 'ghijkl' },
          principal: { orgId: 'o1', userId: 'u1' },
          log: { info: () => {}, error: () => {} },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('maps policy_violation from a same-as-current password', async () => {
    const passwordHash = await argon2.hash('abcdef');
    mockUserLookup({ passwordHash });
    verifyPassword.mockResolvedValue(true);
    await expect(
      changeOwnPasswordHttp(
        {
          id: 'REQ-unit',
          body: { currentPassword: 'abcdef', newPassword: 'abcdef' },
          principal: { orgId: 'o1', userId: 'u1' },
          log: { info: () => {}, error: () => {} },
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: 'PASSWORD_POLICY_VIOLATION',
      details: { violations: ['SAME_AS_CURRENT'] },
    });
  });

  it('audits invalid_current_password as failed before throwing', async () => {
    mockUserLookup({ passwordHash: 'old' });
    verifyPassword.mockResolvedValue(false);
    recordAuditEvent.mockClear();
    await expect(
      changeOwnPasswordHttp(
        {
          id: 'REQ-unit',
          body: { currentPassword: 'abcdef', newPassword: 'ghijkl' },
          principal: { orgId: 'o1', userId: 'u1' },
          log: { info: () => {}, error: () => {} },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password_changed',
        result: 'failed',
      }),
      expect.anything(),
    );
  });
});
