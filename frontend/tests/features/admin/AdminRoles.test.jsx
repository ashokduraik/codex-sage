import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';
import { API_BASE_URL } from '@/shared/api/index';
import AdminRoles from '@/features/admin/AdminRoles';

/**
 * @param {object} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
    clone() {
      return this;
    },
  };
}

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearAuthSession();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession('you@acme.io', {
    permissions: ['roles.manage', 'users.manage'],
  });
});

describe('AdminRoles', () => {
  it('renders role columns including a custom role with human-readable labels only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const path = String(url).replace(API_BASE_URL, '');
        if (path.startsWith('/roles')) {
          return jsonResponse({
            items: ROLES,
            pageInfo: { nextCursor: null, hasMore: false },
          });
        }
        if (path.startsWith('/permissions')) {
          return jsonResponse(CATALOG);
        }
        return jsonResponse({});
      }),
    );

    const { container } = renderWithProviders(<AdminRoles />, {
      route: '/admin/roles',
    });

    expect((await screen.findAllByText('Org Admin')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Custom Analyst').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Manage users').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ask questions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Other permissions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Additional permission').length).toBeGreaterThan(0);

    const text = container.textContent ?? '';
    expect(text).not.toContain('users.manage');
    expect(text).not.toContain('chat.ask');
    expect(text).not.toContain('legacy.unknown');
  });

  it('shows loading then empty when no roles exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const path = String(url).replace(API_BASE_URL, '');
        if (path.startsWith('/roles')) {
          return jsonResponse({
            items: [],
            pageInfo: { nextCursor: null, hasMore: false },
          });
        }
        if (path.startsWith('/permissions')) {
          return jsonResponse(CATALOG);
        }
        return jsonResponse({});
      }),
    );

    renderWithProviders(<AdminRoles />, { route: '/admin/roles' });
    expect(await screen.findByText('No roles are available in this organization.')).toBeTruthy();
  });

  it('shows an error state with retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'FORBIDDEN', message: 'Roles forbidden.' } }, 403)),
    );

    renderWithProviders(<AdminRoles />, { route: '/admin/roles' });
    expect(await screen.findByText('Roles forbidden.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows forbidden when the caller lacks roles.manage', () => {
    renderWithProviders(<AdminRoles />, {
      route: '/admin/roles',
      authUser: {
        id: 'v1',
        email: 'viewer@acme.io',
        displayName: 'Viewer',
        orgId: 'org_test',
        roleIds: [],
        permissions: ['users.manage'],
        mustChangePassword: false,
      },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/permission/i);
  });
});
