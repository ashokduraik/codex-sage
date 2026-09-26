import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setAccessToken } from '@/shared/api/index';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { isInvalidAuditCursorError, useAuditEvents } from '@/features/admin/api/useAuditEvents.js';

afterEach(() => {
  resetApiSessionForTests();
  vi.unstubAllGlobals();
});

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
function createWrapper(queryClient) {
  /**
   * @param {{ children: import('react').ReactNode }} props
   */
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/**
 * @param {object} body JSON body.
 * @param {number} [status]
 */
function jsonFetch(body, status = 200) {
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

describe('isInvalidAuditCursorError', () => {
  it('detects VALIDATION_ERROR details with path cursor', () => {
    expect(
      isInvalidAuditCursorError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [{ path: 'cursor', message: 'cursor is malformed' }],
        }),
      ),
    ).toBe(true);
  });

  it('detects INVALID_CURSOR code', () => {
    expect(
      isInvalidAuditCursorError(
        new ApiError({
          status: 400,
          code: 'INVALID_CURSOR',
          message: 'Pagination cursor is invalid.',
        }),
      ),
    ).toBe(true);
  });

  it('returns false for unrelated validation errors', () => {
    expect(
      isInvalidAuditCursorError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [{ path: 'from', message: 'from must be a valid ISO-8601 instant' }],
        }),
      ),
    ).toBe(false);
  });

  it('returns false for non-ApiError values and missing details', () => {
    expect(isInvalidAuditCursorError(new Error('x'))).toBe(false);
    expect(
      isInvalidAuditCursorError(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
        }),
      ),
    ).toBe(false);
  });
});

describe('useAuditEvents', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    setAccessToken('tok');
  });

  it('requests the first page without a cursor and load-more sends nextCursor', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        jsonFetch({
          items: [{ id: 'e1', action: 'user.create', result: 'success' }],
          pageInfo: { nextCursor: 'n1', hasMore: true },
        }),
      )
      .mockResolvedValueOnce(
        jsonFetch({
          items: [{ id: 'e2', action: 'user.deactivate', result: 'success' }],
          pageInfo: { nextCursor: null, hasMore: false },
        }),
      );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useAuditEvents({ action: 'user.create' }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('cursor=');
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=n1');
    expect(result.current.hasNextPage).toBe(false);
  });

  it('resets the page chain when filters change', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('action=user.deactivate')) {
        return jsonFetch({
          items: [{ id: 'e2' }],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      if (href.includes('cursor=n1')) {
        return jsonFetch({
          items: [{ id: 'e1b' }],
          pageInfo: { nextCursor: null, hasMore: false },
        });
      }
      return jsonFetch({
        items: [{ id: 'e1' }],
        pageInfo: { nextCursor: 'n1', hasMore: true },
      });
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result, rerender } = renderHook(({ filters }) => useAuditEvents(filters), {
      initialProps: { filters: { action: 'user.create' } },
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages?.length).toBe(2));

    rerender({ filters: { action: 'user.deactivate' } });
    await waitFor(() => expect(result.current.data?.pages?.[0]?.items?.[0]?.id).toBe('e2'));
    expect(result.current.data?.pages).toHaveLength(1);
    const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(lastUrl).toContain('action=user.deactivate');
    expect(lastUrl).not.toContain('cursor=');
  });

  it('includes from, to, actor, action, and resourceType in the request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonFetch({ items: [], pageInfo: { nextCursor: null, hasMore: false } }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(
      () =>
        useAuditEvents({
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-09-13T00:00:00.000Z',
          actor: '507f1f77bcf86cd799439011',
          action: 'user.create',
          resourceType: 'user',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('from=2026-09-01T00%3A00%3A00.000Z');
    expect(url).toContain('to=2026-09-13T00%3A00%3A00.000Z');
    expect(url).toContain('actor=507f1f77bcf86cd799439011');
    expect(url).toContain('action=user.create');
    expect(url).toContain('resourceType=user');
  });
});
