import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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
    code: 'ADMIN',
    name: 'Org Admin',
    permissions: ['users.manage', 'roles.manage', 'chat.ask'],
  },
  {
    id: 'r-custom',
    code: 'ANALYST',
    name: 'Custom Analyst',
    permissions: ['chat.ask', 'legacy.unknown'],
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
  it('renders a searchable summary with S.No, code, and name', async () => {
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

    expect(await screen.findByLabelText('Search roles')).toBeTruthy();
    expect(screen.getByText('S.No')).toBeTruthy();
    expect((await screen.findAllByText('Org Admin')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Custom Analyst').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ADMIN').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ANALYST').length).toBeGreaterThan(0);
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('3 permissions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'First page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy();

    const text = container.textContent ?? '';
    expect(text).not.toContain('users.manage');
    expect(text).not.toContain('chat.ask');
    expect(text).not.toContain('legacy.unknown');
  });

  it('sends the search query to GET /roles', async () => {
    const fetchMock = vi.fn(async (url) => {
      const path = String(url).replace(API_BASE_URL, '');
      if (path.startsWith('/roles')) {
        return jsonResponse({
          items: [ROLES[0]],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      if (path.startsWith('/permissions')) {
        return jsonResponse(CATALOG);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<AdminRoles />, { route: '/admin/roles?q=ADMIN' });
    expect(await screen.findByText('Org Admin')).toBeTruthy();
    const rolesCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/roles?'));
    expect(String(rolesCall[0])).toContain('q=ADMIN');
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
    expect(await screen.findByText('No roles match this search.')).toBeTruthy();
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

  it('creates a role with a code and catalog permissions', async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const path = String(url).replace(API_BASE_URL, '');
      const method = (init.method ?? 'GET').toUpperCase();
      if (path.startsWith('/roles') && method === 'POST') {
        return jsonResponse(
          {
            id: 'r-new',
            code: 'READER',
            name: 'Reader',
            permissions: ['chat.ask'],
          },
          201,
        );
      }
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
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<AdminRoles />, { route: '/admin/roles' });
    expect((await screen.findAllByText('Org Admin')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'reader' } });
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Reader' } });
    expect(screen.getByRole('heading', { name: 'Users and roles' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeTruthy();
    expect(screen.getByText('0 of 3 selected')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Ask questions'));
    expect(screen.getByText('1 of 3 selected')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create role' }).at(-1));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/roles') && init?.method === 'POST');
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      expect(body.code).toBe('READER');
      expect(body.name).toBe('Reader');
      expect(body.permissions).toEqual(['chat.ask']);
    });
  });
});
