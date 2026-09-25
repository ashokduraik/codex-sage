/**
 * Role service unit tests — built-in and catalog guards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audit/index.js', () => ({
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock('../authorization/roleCache.js', () => ({
  invalidateRole: vi.fn(),
}));

vi.mock('../authorization/permissionCatalog.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isKnownPermissionKey: vi.fn((key) => key === 'org.view' || key === 'chat.ask'),
  };
});

vi.mock('./membership.repository.js', () => ({
  isRoleReferencedByActiveMembership: vi.fn(async () => false),
}));

vi.mock('./role.repository.js', () => ({
  createRole: vi.fn(),
  findRoleById: vi.fn(),
  listRolesPage: vi.fn(async () => ({
    items: [],
    pageInfo: { nextCursor: null, hasMore: false },
  })),
  softDeleteRole: vi.fn(async () => ({ modifiedCount: 1 })),
  updateRole: vi.fn(),
}));

vi.mock('../projectMembers/projectAclCache.js', () => ({
  bumpProjectAclVersion: vi.fn(async () => {}),
}));

import { isRoleReferencedByActiveMembership } from './membership.repository.js';
import {
  createRole as createRoleInRepo,
  findRoleById,
  softDeleteRole as softDeleteRoleInRepo,
  updateRole as updateRoleInRepo,
} from './role.repository.js';
import {
  assertKnownPermissions,
  createRole,
  mapRoleToDto,
  softDeleteRole,
  updateRole,
} from './role.service.js';

describe('role.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRoleReferencedByActiveMembership.mockResolvedValue(false);
  });

  it('rejects a permission string absent from the catalog', () => {
    expect(() => assertKnownPermissions(['not.a.real.permission'])).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_PERMISSION' }),
    );
  });

  it('createRole rejects unknown permissions before writing', async () => {
    await expect(
      createRole({
        orgId: 'org1',
        actorUserId: 'actor',
        name: 'Custom',
        permissions: ['not.real'],
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' });
    expect(createRoleInRepo).not.toHaveBeenCalled();
  });

  it('updateRole forwards built-in immutability from the repository', async () => {
    updateRoleInRepo.mockRejectedValue(
      Object.assign(new Error('immutable'), { code: 'BUILT_IN_ROLE_IMMUTABLE' }),
    );
    await expect(
      updateRole({
        orgId: 'org1',
        actorUserId: 'actor',
        roleId: 'role1',
        permissions: ['org.view'],
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'BUILT_IN_ROLE_IMMUTABLE' });
  });

  it('softDeleteRole throws ROLE_IN_USE when memberships reference it', async () => {
    findRoleById.mockResolvedValue({
      _id: 'role1',
      name: 'Custom',
      isBuiltIn: false,
    });
    isRoleReferencedByActiveMembership.mockResolvedValue(true);
    await expect(
      softDeleteRole({
        orgId: 'org1',
        actorUserId: 'actor',
        roleId: 'role1',
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'ROLE_IN_USE' });
    expect(softDeleteRoleInRepo).not.toHaveBeenCalled();
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
    expect(dto).not.toHaveProperty('passwordHash');
  });
});
