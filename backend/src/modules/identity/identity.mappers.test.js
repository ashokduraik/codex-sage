/**
 * Identity mapper unit tests — secrets must never appear on DTOs.
 */
import { describe, expect, it } from 'vitest';
import {
  containsForbiddenSecretKey,
  mapRoleToDto,
  mapUserToDto,
} from './identity.mappers.js';

describe('identity.mappers', () => {
  it('maps a user without passwordHash or token-shaped keys', () => {
    const dto = mapUserToDto(
      {
        _id: '6712f0b1c9a41d2f8e4b3a04',
        email: 'ada@acme.example',
        displayName: 'Ada',
        userStatus: 'invited',
        lastLoginAt: null,
        createdAt: new Date('2026-09-11T09:14:22.481Z'),
        passwordHash: 'should-not-leak',
      },
      [{ _id: '6712f0b1c9a41d2f8e4b3a03', name: 'Member', isBuiltIn: true }],
    );
    expect(dto.passwordResetStatus).toBe('none');
    expect(containsForbiddenSecretKey(dto)).toBe(false);
    expect(dto).not.toHaveProperty('passwordHash');
  });

  it('maps passwordResetStatus completed when passwordUpdatedAt is set', () => {
    const completedAt = new Date('2026-09-11T09:20:00.000Z');
    const dto = mapUserToDto(
      {
        _id: '6712f0b1c9a41d2f8e4b3a04',
        email: 'ada@acme.example',
        displayName: 'Ada',
        userStatus: 'active',
        passwordUpdatedAt: completedAt,
        createdAt: completedAt,
      },
      [],
    );
    expect(dto.passwordResetStatus).toBe('completed');
    expect(dto.passwordResetCompletedAt).toBe(completedAt.toISOString());
  });

  it('maps a built-in role with code-resolved permissions', () => {
    const dto = mapRoleToDto({
      _id: '6712f0b1c9a41d2f8e4b3a03',
      name: 'Viewer',
      description: 'Read only',
      isBuiltIn: true,
      builtInKey: 'viewer',
      permissions: [],
      createdAt: new Date('2026-09-11T09:14:22.481Z'),
    });
    expect(dto.permissions).toContain('org.view');
    expect(dto.isBuiltIn).toBe(true);
    expect(containsForbiddenSecretKey(dto)).toBe(false);
  });

  it('detects forbidden secret keys nested in objects', () => {
    expect(containsForbiddenSecretKey({ nested: { passwordHash: 'x' } })).toBe(true);
    expect(containsForbiddenSecretKey({ id: '1' })).toBe(false);
  });
});
