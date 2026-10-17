/**
 * Unit tests for admin password-reset route edge outcomes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/modules/access/index.js', () => ({
  adminSetPassword: vi.fn(),
  getPasswordResetStatus: vi.fn(() => ({ state: 'none', completedAt: null })),
  buildAuditContextFromRequest: vi.fn(() => ({
    correlationId: 'corr-1',
    ip: undefined,
    userAgent: undefined,
  })),
  recordAuditEvent: vi.fn(async () => {}),
  revokeAllLoginSessionsForUser: vi.fn(async () => ({})),
  PASSWORD_MIN_LENGTH: 6,
}));

import { adminSetPassword } from '../../../src/modules/access/index.js';
import { resetUserPasswordHttp } from '../../../src/modules/masters/users.js';

describe('adminPasswordReset.routes edge outcomes', () => {
  it('maps unexpected service outcome to INTERNAL_ERROR', async () => {
    adminSetPassword.mockResolvedValue({ outcome: 'password_changed' });
    await expect(
      resetUserPasswordHttp({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        body: { newPassword: 'abcdef' },
        log: {},
        id: 'corr-1',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('rejects empty userId with VALIDATION_ERROR', async () => {
    await expect(
      resetUserPasswordHttp({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { userId: '' },
        body: { newPassword: 'abcdef' },
        log: {},
        id: 'corr-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
