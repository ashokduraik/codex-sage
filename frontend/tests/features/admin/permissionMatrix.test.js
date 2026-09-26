import { describe, expect, it } from 'vitest';
import { buildPermissionMatrixRows } from '@/features/admin/AdminRoles.jsx';

const CATALOG = {
  groups: [
    {
      id: 'users',
      label: 'Users and roles',
      permissions: [
        { key: 'users.manage', label: 'Manage users', description: 'User admin' },
        { key: 'roles.manage', label: 'Manage roles', description: 'Role admin' },
      ],
    },
    {
      id: 'chat',
      label: 'Chat',
      permissions: [{ key: 'chat.ask', label: 'Ask questions', description: 'Ask' }],
    },
  ],
};

const ROLES = [
  {
    id: 'r-admin',
    name: 'Org Admin',
    permissions: ['users.manage', 'roles.manage', 'chat.ask'],
    isBuiltIn: true,
  },
  {
    id: 'r-custom',
    name: 'Custom Analyst',
    permissions: ['chat.ask', 'legacy.unknown'],
    isBuiltIn: false,
  },
];

describe('buildPermissionMatrixRows', () => {
  it('places unknown permission keys under the other group with a generic label', () => {
    const rows = buildPermissionMatrixRows(CATALOG, ROLES, 'Other permissions', 'Additional permission');
    const other = rows.find((row) => row.groupId === 'other');
    expect(other).toBeTruthy();
    expect(other.permissions[0].key).toBe('legacy.unknown');
    expect(other.permissions[0].label).toBe('Additional permission');
  });

  it('returns catalog groups when there are no unknown keys', () => {
    const rows = buildPermissionMatrixRows(CATALOG, [{ id: 'r1', permissions: ['chat.ask'] }], 'Other permissions', 'Additional permission');
    expect(rows.some((row) => row.groupId === 'other')).toBe(false);
    expect(rows).toHaveLength(2);
  });
});
