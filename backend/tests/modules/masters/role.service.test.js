/**
 * Role service unit tests — catalog guards and dynamic ADMIN updates.
 */
import { Role } from '../../../src/models/role.model.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/modules/access/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordAuditEvent: vi.fn(async () => {}),
    invalidateRole: vi.fn(),
    isKnownPermissionKey: vi.fn((key) => key === 'org.view' || key === 'chat.ask'),
  };
});

vi.mock('../../../src/modules/masters/users.js', () => ({
  isRoleReferencedByActiveUser: vi.fn(async () => false),
}));

vi.mock('../../../src/modules/masters/projectMembers.js', () => ({
  bumpProjectAclVersion: vi.fn(async () => {}),
}));

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: vi.fn(async () => ({
        withTransaction: async (fn) => fn(),
        endSession: async () => {},
      })),
    },
  };
});

import { isRoleReferencedByActiveUser } from '../../../src/modules/masters/users.js';
import { assertKnownPermissions, createRole, mapRoleToDto, softDeleteRole, updateRole } from '../../../src/modules/masters/roles.js';

const ORG_ID = '665f1c9d4b2a8e0012a4f010';
const ROLE_ID = '665f1c9d4b2a8e0012a4f011';

describe('role.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    isRoleReferencedByActiveUser.mockResolvedValue(false);
  });

  it('rejects a permission string absent from the catalog', () => {
    expect(() => assertKnownPermissions(['not.a.real.permission'])).toThrow(expect.objectContaining({ code: 'UNKNOWN_PERMISSION' }));
  });

  it('createRole rejects unknown permissions before writing', async () => {
    const createSpy = vi.spyOn(Role, 'create');
    await expect(
      createRole({
        orgId: ORG_ID,
        actorUserId: 'actor',
        code: 'CUSTOM',
        name: 'Custom',
        permissions: ['not.real'],
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('updateRole allows ADMIN name and permission changes', async () => {
    const saved = {
      _id: ROLE_ID,
      code: 'ADMIN',
      name: 'Org Admin',
      description: 'Full organization administration.',
      permissions: ['org.view'],
      createdAt: new Date('2026-09-11T09:14:22.481Z'),
      /**
       * Persists the in-memory patch so mapRoleToDto sees the new name.
       * @returns {Promise<object>}
       */
      async save() {
        return this;
      },
    };
    vi.spyOn(Role, 'findOne').mockReturnValue({
      session() {
        return this;
      },
      exec: vi.fn().mockResolvedValue(saved),
    });
    const dto = await updateRole({
      orgId: ORG_ID,
      actorUserId: 'actor',
      roleId: ROLE_ID,
      name: 'Renamed Admin',
      permissions: ['org.view'],
      correlationId: 'c1',
    });
    expect(dto.name).toBe('Renamed Admin');
    expect(dto.code).toBe('ADMIN');
    expect(dto).not.toHaveProperty('isBuiltIn');
  });

  it('softDeleteRole throws ROLE_IN_USE when users reference it', async () => {
    vi.spyOn(Role, 'findOne').mockReturnValue({
      session() {
        return this;
      },
      exec: vi.fn().mockResolvedValue({
        _id: ROLE_ID,
        code: 'CUSTOM',
        name: 'Custom',
      }),
    });
    isRoleReferencedByActiveUser.mockResolvedValue(true);
    await expect(
      softDeleteRole({
        orgId: ORG_ID,
        actorUserId: 'actor',
        roleId: ROLE_ID,
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'ROLE_IN_USE' });
  });

  it('maps a role from stored permissions and exposes code', () => {
    const dto = mapRoleToDto({
      _id: '6712f0b1c9a41d2f8e4b3a03',
      code: 'VIEWER',
      name: 'Viewer',
      description: 'Read only',
      permissions: ['org.view', 'chat.ask'],
      createdAt: new Date('2026-09-11T09:14:22.481Z'),
    });
    expect(dto.code).toBe('VIEWER');
    expect(dto.permissions).toEqual(['org.view', 'chat.ask']);
    expect(dto).not.toHaveProperty('isBuiltIn');
    expect(dto).not.toHaveProperty('passwordHash');
  });
});
