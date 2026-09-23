/**
 * Source-versions infinite query hook.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/projects/api/sourcesApi.js', () => ({
  SOURCE_VERSION_LIST_PAGE_SIZE: 20,
  sourceVersionsQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'source-versions']),
  listProjectSourceVersions: vi.fn(),
}));

import { listProjectSourceVersions } from '@/features/projects/api/sourcesApi.js';
import { flattenSourceVersionPages, useSourceVersions } from './useSourceVersions.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useSourceVersions', () => {
  it('does not fetch when projectId is missing', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHook(() => useSourceVersions(undefined), {
      wrapper: createWrapper(queryClient),
    });
    expect(listProjectSourceVersions).not.toHaveBeenCalled();
  });

  it('pages with nextCursor and flattens items', async () => {
    listProjectSourceVersions
      .mockResolvedValueOnce({
        items: [{ id: 'sv1' }],
        pageInfo: { nextCursor: 'c2', hasMore: true },
      })
      .mockResolvedValueOnce({
        items: [{ id: 'sv2' }],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useSourceVersions('p1', { limit: 1 }), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(listProjectSourceVersions).toHaveBeenCalledWith({
      projectId: 'p1',
      cursor: undefined,
      limit: 1,
      signal: expect.any(AbortSignal),
    });
    expect(flattenSourceVersionPages(result.current.data)).toEqual([{ id: 'sv1' }]);
    await result.current.fetchNextPage();
    await waitFor(() => {
      expect(flattenSourceVersionPages(result.current.data)).toEqual([
        { id: 'sv1' },
        { id: 'sv2' },
      ]);
    });
    expect(listProjectSourceVersions).toHaveBeenLastCalledWith({
      projectId: 'p1',
      cursor: 'c2',
      limit: 1,
      signal: expect.any(AbortSignal),
    });
  });

  it('flattens missing pages as an empty list', () => {
    expect(flattenSourceVersionPages(undefined)).toEqual([]);
    expect(flattenSourceVersionPages({ pages: [{ items: null }] })).toEqual([]);
  });
});
