import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';
import { API_BASE_URL } from '@/shared/api/index';
import AdminUsers from '@/features/admin/AdminUsers';

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

const ROLE_VIEWER = {
  id: '507f1f77bcf86cd799439011',
  name: 'Viewer',
  isBuiltIn: true,
  permissions: ['chat.ask'],
};
const ROLE_MEMBER = {
  id: '507f1f77bcf86cd799439012',
  name: 'Member',
  isBuiltIn: true,
  permissions: ['chat.ask', 'sources.upload'],
};

const USER_LENA = {
  id: 'u1',
  displayName: 'Lena Park',
  email: 'lena.park@acme.io',
  userStatus: 'active',
  roles: [{ id: ROLE_VIEWER.id, name: 'Viewer', isBuiltIn: true }],
  lastLoginAt: '2024-01-01T00:00:00.000Z',
};

/**
 * @param {ReturnType<typeof vi.fn>} fetchMock
 * @param {{
 *   users?: object[],
 *   roles?: object[],
 *   createError?: { code: string, message: string, status?: number },
 *   onDeactivate?: () => object,
 * }} [options]
 */
function stubAdminFetch(fetchMock, options = {}) {
  const users = options.users ?? [USER_LENA];
  const roles = options.roles ?? [ROLE_VIEWER, ROLE_MEMBER];

  fetchMock.mockImplementation(async (url, init = {}) => {
    const path = String(url).replace(API_BASE_URL, '');
    const method = (init.method ?? 'GET').toUpperCase();

    if (path.startsWith('/roles')) {
      return jsonResponse({
        items: roles,
        pageInfo: { nextCursor: null, hasMore: false },
      });
    }
    if (path.startsWith('/users') && method === 'GET') {
      return jsonResponse({
        items: users,
        pageInfo: { nextCursor: null, hasMore: false },
      });
    }
    if (path === '/users' && method === 'POST') {
      if (options.createError) {
        return jsonResponse(
          {
            error: {
              code: options.createError.code,
              message: options.createError.message,
            },
          },
          options.createError.status ?? 409,
        );
      }
      const body = JSON.parse(init.body);
      return jsonResponse(
        {
          id: 'u-new',
          displayName: body.displayName,
          email: body.email,
          userStatus: 'invited',
          roles: roles.filter((role) => body.roleIds.includes(role.id)),
          lastLoginAt: null,
        },
        201,
      );
    }
    if (path.includes('/reset-password') && method === 'POST') {
      return jsonResponse({ passwordResetStatus: 'completed' });
    }
    if (method === 'DELETE' && path.startsWith('/users/')) {
      return jsonResponse({ id: 'u1' });
    }
    if (method === 'PATCH' && path.startsWith('/users/')) {
      return jsonResponse({ ...USER_LENA, roles: [ROLE_MEMBER] });
    }
    if (path.endsWith('/deactivate')) {
      if (options.onDeactivate) {
        return options.onDeactivate();
      }
      return jsonResponse({ ...USER_LENA, userStatus: 'disabled' });
    }
    if (path.endsWith('/activate')) {
      return jsonResponse({ ...USER_LENA, userStatus: 'active' });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'missing stub' } }, 404);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearAuthSession();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession('you@acme.io', {
    permissions: ['users.manage', 'roles.manage'],
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('AdminUsers', () => {
  it('renders user, roles, status, and last sign-in without project access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });

    expect(await screen.findByText('Lena Park')).toBeTruthy();
    expect(screen.getByText('lena.park@acme.io')).toBeTruthy();
    expect(screen.getAllByText('Viewer').length).toBeGreaterThan(0);
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.queryByText('Project access')).toBeNull();
  });

  it('shows empty state when the page has no users', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock, { users: [] });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });

    expect(await screen.findByText('No users match these filters.')).toBeTruthy();
  });

  it('shows a list error with retry', async () => {
    const fetchMock = vi.fn(async (url) => {
      const path = String(url).replace(API_BASE_URL, '');
      if (path.startsWith('/users')) {
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Users unavailable.' } }, 500);
      }
      if (path.startsWith('/roles')) {
        return jsonResponse({
          items: [ROLE_VIEWER],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });

    expect(await screen.findByText('Users unavailable.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('creates a user and sends Idempotency-Key with roleIds', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'New Hire' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new.hire@acme.io' },
    });
    fireEvent.click(await screen.findByLabelText('Member'));

    const dialogInvite = screen.getAllByRole('button', { name: /Invite user/i }).at(-1);
    fireEvent.click(dialogInvite);

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/users') && init?.method === 'POST');
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      expect(body.roleIds).toEqual(expect.arrayContaining([ROLE_VIEWER.id, ROLE_MEMBER.id]));
      expect(createCall[1].headers['Idempotency-Key']).toBeTruthy();
    });
  });

  it('keeps the create dialog open on duplicate email 409', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock, {
      createError: {
        code: 'IDENTITY_DUPLICATE_EMAIL',
        message: 'A user with this email already exists in the organization.',
        status: 409,
      },
    });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'Dup' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'dup@acme.io' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Invite user/i }).at(-1));

    expect(await screen.findByText('A user with this email already exists in the organization.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Create user' })).toBeTruthy();
    expect(/** @type {HTMLInputElement} */ (screen.getByLabelText('Email')).value).toBe('dup@acme.io');
  });

  it('opens remove consequences dialog and cancels without DELETE', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove user' }));
    expect(screen.getByText(/lose access to this organization/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

  it('confirms remove and calls DELETE', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove user' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/users/u1') && init?.method === 'DELETE')).toBe(true);
    });
  });

  it('sets a password without claiming email delivery or echoing the secret', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password' }));

    expect(screen.getByText(/out of band/i)).toBeTruthy();
    expect(screen.queryByText(/was sent/i)).toBeNull();

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'NewSecretPass1!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'NewSecretPass1!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText(/Password set completed/i)).toBeTruthy();
    expect(screen.queryByDisplayValue('NewSecretPass1!')).toBeNull();
  });

  it('renders a 403 message and keeps the user signed in', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock, {
      onDeactivate: () => jsonResponse({ error: { code: 'FORBIDDEN', message: 'Not permitted.' } }, 403),
    });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText('Not permitted.')).toBeTruthy();
    expect(screen.getByText('Lena Park')).toBeTruthy();
  });

  it('shows forbidden when the caller lacks users.manage', () => {
    renderWithProviders(<AdminUsers />, {
      route: '/admin/users',
      authUser: {
        id: 'v1',
        email: 'viewer@acme.io',
        displayName: 'Viewer',
        orgId: 'org_test',
        roleIds: [],
        permissions: ['chat.ask'],
        mustChangePassword: false,
      },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/permission/i);
  });

  it('edits roles and PATCHes roleIds', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit roles' }));
    fireEvent.click(await screen.findByLabelText('Member'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).includes('/users/u1') && init?.method === 'PATCH' && JSON.parse(init.body).roleIds.includes(ROLE_MEMBER.id),
        ),
      ).toBe(true);
    });
  });

  it('activates a disabled user', async () => {
    const disabledUser = { ...USER_LENA, userStatus: 'disabled' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock, { users: [disabledUser] });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/activate'))).toBe(true);
    });
  });

  it('paginates with next cursor and returns to the first page', async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const path = String(url).replace(API_BASE_URL, '');
      const method = (init.method ?? 'GET').toUpperCase();
      if (path.startsWith('/roles')) {
        return jsonResponse({
          items: [ROLE_VIEWER],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      if (path.startsWith('/users') && method === 'GET') {
        if (path.includes('cursor=')) {
          return jsonResponse({
            items: [
              {
                ...USER_LENA,
                id: 'u2',
                displayName: 'Second User',
                email: 'second@acme.io',
              },
            ],
            pageInfo: { nextCursor: null, hasMore: false },
          });
        }
        return jsonResponse({
          items: [USER_LENA],
          pageInfo: { nextCursor: 'cursor-2', hasMore: true },
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Second User')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    expect(await screen.findByText('Lena Park')).toBeTruthy();
  });

  it('loads filters from the URL into the users request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, {
      route: `/admin/users?userStatus=active&roleId=${ROLE_VIEWER.id}`,
    });
    await screen.findByText('Lena Park');

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('userStatus=active') && String(url).includes(`roleId=${ROLE_VIEWER.id}`)),
      ).toBe(true);
    });
  });

  it('debounces search into the q query param', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.change(screen.getByPlaceholderText('Search users'), {
      target: { value: 'pri' },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('q=pri'))).toBe(true);
    });
    vi.useRealTimers();
  });

  it('shows password mismatch before submit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password' }));
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'aaa' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'bbb' },
    });
    expect(screen.getByText('Passwords do not match')).toBeTruthy();
  });

  it('shows remove failure inline', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);
    fetchMock.mockImplementation(async (url, init = {}) => {
      const path = String(url).replace(API_BASE_URL, '');
      if (init.method === 'DELETE') {
        return jsonResponse({ error: { code: 'LAST_ADMIN_REQUIRED', message: 'Keep an admin.' } }, 409);
      }
      const roles = [ROLE_VIEWER, ROLE_MEMBER];
      if (path.startsWith('/roles')) {
        return jsonResponse({
          items: roles,
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      if (path.startsWith('/users') && (init.method ?? 'GET') === 'GET') {
        return jsonResponse({
          items: [USER_LENA],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      return jsonResponse({});
    });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove user' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }));
    expect(await screen.findByText('Keep an admin.')).toBeTruthy();
  });

  it('shows role edit failure inline', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (init.method === 'PATCH') {
        return jsonResponse({ error: { code: 'FORBIDDEN', message: 'Cannot change roles.' } }, 403);
      }
      return original(url, init);
    });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit roles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Cannot change roles.')).toBeTruthy();
  });

  it('closes the password dialog after completion', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password' }));
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'NewSecretPass1!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'NewSecretPass1!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText(/Password set completed/i)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1));
    expect(screen.queryByText(/Password set completed/i)).toBeNull();
  });

  it('shows reset password API errors', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (String(url).includes('/reset-password')) {
        return jsonResponse(
          {
            error: {
              code: 'PASSWORD_POLICY_VIOLATION',
              message: 'Password too weak.',
            },
          },
          400,
        );
      }
      return original(url, init);
    });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password' }));
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'weak' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'weak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('Password too weak.')).toBeTruthy();
  });

  it('renders a user with no roles', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock, {
      users: [{ ...USER_LENA, roles: [] }],
    });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('cancels create and roles dialogs without submitting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Create user' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit roles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Edit roles for/i)).toBeNull();
  });

  it('closes dialogs via Escape which exercises onOpenChange', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');

    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    expect(screen.getByRole('heading', { name: 'Create user' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Create user' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit roles' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText(/Edit roles for/i)).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove user' }));
    expect(screen.getByText(/lose access/i)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText(/lose access/i)).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByLabelText('New password')).toBeNull();
    });
  });

  it('shows create error correlation id when provided', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAdminFetch(fetchMock);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (String(url).endsWith('/users') && init.method === 'POST') {
        return {
          ok: false,
          status: 409,
          headers: {
            get(name) {
              return name.toLowerCase() === 'x-correlation-id' ? 'corr-create' : null;
            },
          },
          async text() {
            return JSON.stringify({
              error: {
                code: 'IDENTITY_DUPLICATE_EMAIL',
                message: 'Duplicate.',
              },
            });
          },
          async json() {
            return {
              error: {
                code: 'IDENTITY_DUPLICATE_EMAIL',
                message: 'Duplicate.',
              },
            };
          },
          clone() {
            return this;
          },
        };
      }
      return original(url, init);
    });

    renderWithProviders(<AdminUsers />, { route: '/admin/users' });
    await screen.findByText('Lena Park');
    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'Dup' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'dup@acme.io' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Invite user/i }).at(-1));
    expect(await screen.findByText('Duplicate.')).toBeTruthy();
    expect(screen.getByText(/corr-create/)).toBeTruthy();
  });
});
