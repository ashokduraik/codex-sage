import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';
import { API_BASE_URL } from '@/shared/api/index';
import AdminAudit from '@/features/admin/AdminAudit';

/**
 * @param {object} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return key ? headers[key] : null;
      },
    },
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

const EVENT_SUCCESS = {
  id: 'e1',
  action: 'user.create',
  resourceType: 'user',
  resourceId: 'u-target',
  result: 'success',
  actor: { id: 'u-actor', email: 'admin@acme.io' },
  correlationId: 'REQ-ABC',
  context: {
    previousStatus: 'invited',
    nextStatus: 'active',
    password: 'should-not-render',
    token: 'tok',
    unknownField: 'hidden',
  },
  createdAt: '2026-09-10T12:00:00.000Z',
  ip: '1.2.3.4',
  userAgent: 'SecretAgent/1.0',
};

const EVENT_DENIED = {
  id: 'e2',
  action: 'authz.denied',
  resourceType: 'route',
  resourceId: null,
  result: 'denied',
  actor: { id: 'u-actor', email: 'viewer@acme.io' },
  correlationId: 'REQ-DEF',
  context: { permissionKey: 'users.manage', route: '/users', method: 'GET' },
  createdAt: '2026-09-11T09:00:00.000Z',
};

const EVENT_FAILED = {
  id: 'e3',
  action: 'user.deactivate',
  resourceType: 'user',
  resourceId: 'u-fail',
  result: 'failed',
  actor: null,
  correlationId: null,
  context: null,
  createdAt: '2026-09-11T10:00:00.000Z',
};

const EVENT_SPARSE = {
  id: 'e4',
  action: 'user.update',
  resourceType: 'user',
  resourceId: null,
  result: 'success',
  actor: { id: 'u-only-id', email: null },
  createdAt: null,
};

/**
 * @param {ReturnType<typeof vi.fn>} fetchMock
 * @param {{
 *   pages?: Array<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>,
 *   error?: { status: number, code: string, message: string, details?: unknown },
 *   users?: object[],
 * }} [options]
 */
function stubAuditFetch(fetchMock, options = {}) {
  const pages = options.pages ?? [
    {
      items: [EVENT_SUCCESS, EVENT_DENIED, EVENT_FAILED],
      pageInfo: { nextCursor: null, hasMore: false },
    },
  ];
  let pageIndex = 0;
  const users = options.users ?? [{ id: 'u-actor', displayName: 'Admin', email: 'admin@acme.io', roles: [] }];

  fetchMock.mockImplementation(async (url) => {
    const path = String(url).replace(API_BASE_URL, '');

    if (options.error && path.startsWith('/audit-events')) {
      return jsonResponse(
        {
          error: {
            code: options.error.code,
            message: options.error.message,
            details: options.error.details,
          },
        },
        options.error.status,
        { 'X-Correlation-Id': 'REQ-ERR' },
      );
    }

    if (path.startsWith('/users')) {
      return jsonResponse({
        items: users,
        pageInfo: { nextCursor: null, hasMore: false },
      });
    }

    if (path.startsWith('/audit-events')) {
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      return jsonResponse(page);
    }

    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession('you@acme.io', {
    permissions: ['audit.view', 'users.manage'],
  });
});

describe('AdminAudit', () => {
  it('lists events, expands detail, and never renders secrets, ip, or userAgent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock);

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });

    await waitFor(() => expect(screen.getByText('admin@acme.io')).toBeTruthy());
    expect(screen.getByText('User created')).toBeTruthy();
    expect(screen.getByText('Success')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('System')).toBeTruthy();
    expect(screen.queryByText('1.2.3.4')).toBeNull();
    expect(screen.queryByText('SecretAgent/1.0')).toBeNull();
    expect(screen.queryByText(/should-not-render/)).toBeNull();
    expect(screen.queryByText(/\bevents\b/i)).toBeNull();

    fireEvent.click(screen.getByText('admin@acme.io'));
    await waitFor(() => expect(screen.getByText(/Reference:/)).toBeTruthy());
    expect(screen.getByText(/REQ-ABC/)).toBeTruthy();
    expect(screen.getByText(/previousStatus: invited/)).toBeTruthy();
    expect(screen.getByText(/nextStatus: active/)).toBeTruthy();
    expect(screen.queryByText(/password/i)).toBeNull();
    expect(screen.queryByText(/unknownField/)).toBeNull();
    expect(screen.queryByText('tok')).toBeNull();
  });

  it('sends UTC day-boundary from/to and resets the list when filters change', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      pages: [
        {
          items: [EVENT_SUCCESS],
          pageInfo: { nextCursor: null, hasMore: false },
        },
        {
          items: [],
          pageInfo: { nextCursor: null, hasMore: false },
        },
      ],
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('To date'), {
      target: { value: '2026-09-12' },
    });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('from=2026-09-01T00%3A00%3A00.000Z'))).toBe(true);
      expect(urls.some((url) => url.includes('to=2026-09-13T00%3A00%3A00.000Z'))).toBe(true);
    });
  });

  it('omits an invalid to-date from the audit query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      pages: [
        {
          items: [EVENT_SUCCESS],
          pageInfo: { nextCursor: null, hasMore: false },
        },
      ],
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit?to=not-a-date' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => !url.includes('to='))).toBe(true);
  });

  it('loads the next page with nextCursor when Load more is clicked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      pages: [
        {
          items: [EVENT_SUCCESS],
          pageInfo: { nextCursor: 'cursor-2', hasMore: true },
        },
        {
          items: [EVENT_DENIED],
          pageInfo: { nextCursor: null, hasMore: false },
        },
      ],
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    await waitFor(() => expect(screen.getByText('admin@acme.io')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('viewer@acme.io')).toBeTruthy());
    const auditUrls = fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/audit-events'));
    expect(auditUrls.some((url) => url.includes('cursor=cursor-2'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows distinct empty states and clear-filters resets the query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      pages: [
        { items: [], pageInfo: { nextCursor: null, hasMore: false } },
        { items: [], pageInfo: { nextCursor: null, hasMore: false } },
      ],
    });

    renderWithProviders(<AdminAudit />, {
      route: '/admin/audit?action=user.create',
    });

    await waitFor(() => expect(screen.getByText('No audit events match these filters.')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('No audit events yet.')).toBeTruthy());
  });

  it('renders a loading skeleton before the first page resolves', async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise(() => {
          /* never resolve */
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    expect(screen.getByLabelText('Loading…')).toBeTruthy();
  });

  it('renders list errors with retry and correlation id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Internal server error')).toBeTruthy();
    expect(within(alert).getByText(/Support reference: REQ-ERR/)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('renders forbidden without signing the user out', async () => {
    clearAuthSession();
    seedAuthSession('you@acme.io', { permissions: [] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('You do not have permission to perform this action.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows an alert for invalid cursor errors instead of a silent empty list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      error: {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: [{ path: 'cursor', message: 'cursor is malformed' }],
      },
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Request validation failed.')).toBeTruthy();
    expect(screen.queryByText('No audit events yet.')).toBeNull();
  });

  it('labels missing optional fields as not recorded and uses actor id fallback', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      pages: [
        {
          items: [EVENT_SPARSE],
          pageInfo: { nextCursor: null, hasMore: false },
        },
      ],
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    await waitFor(() => expect(screen.getByText('u-only-id')).toBeTruthy());
    fireEvent.click(screen.getByText('u-only-id'));
    await waitFor(() => expect(screen.getAllByText(/Not recorded/).length).toBeGreaterThan(0));
  });

  it('sends action and resourceType from the URL and retries after a list failure', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let auditCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      const path = String(url).replace(API_BASE_URL, '');
      if (path.startsWith('/users')) {
        return jsonResponse({
          items: [{ id: 'u-actor', email: 'admin@acme.io', roles: [] }],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      if (path.startsWith('/audit-events')) {
        auditCalls += 1;
        expect(path).toContain('action=user.create');
        expect(path).toContain('resourceType=user');
        if (auditCalls === 1) {
          return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500, { 'X-Correlation-Id': 'REQ-RETRY' });
        }
        return jsonResponse({
          items: [EVENT_SUCCESS],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    });

    renderWithProviders(<AdminAudit />, {
      route: '/admin/audit?action=user.create&resourceType=user',
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Internal server error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('admin@acme.io')).toBeTruthy());
    expect(auditCalls).toBeGreaterThanOrEqual(2);
  });

  it('renders unknown results verbatim and resource-type-only targets', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      pages: [
        {
          items: [
            {
              id: 'e-unknown',
              action: 'custom.action',
              resourceType: 'user',
              resourceId: null,
              result: 'weird',
              actor: { id: '', email: '' },
              createdAt: '2026-09-11T10:00:00.000Z',
            },
          ],
          pageInfo: { nextCursor: null, hasMore: false },
        },
      ],
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    await waitFor(() => expect(screen.getByText('weird')).toBeTruthy());
    expect(screen.getByText('System')).toBeTruthy();
    fireEvent.click(screen.getByText('System'));
    await waitFor(() => expect(screen.getByText(/Target: User$/)).toBeTruthy());
  });

  it('shows a 403 alert when the API rejects despite a client-side permission gate', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock, {
      error: {
        status: 403,
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action.',
      },
    });

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('You do not have permission to perform this action.');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('omits the actor filter when the caller lacks users.manage', async () => {
    clearAuthSession();
    seedAuthSession('you@acme.io', { permissions: ['audit.view'] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stubAuditFetch(fetchMock);

    renderWithProviders(<AdminAudit />, { route: '/admin/audit' });
    await waitFor(() => expect(screen.getByText('admin@acme.io')).toBeTruthy());
    expect(screen.queryByLabelText('Actor filter')).toBeNull();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => !url.includes('/users'))).toBe(true);
  });
});
