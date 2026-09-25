/**
 * useProjects infinite query.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjects: vi.fn(),
  };
});

import { listProjects } from '@/features/projects/api/projectsApi.js';
import { flattenProjectPages, useProjects } from '@/features/projects/hooks/useProjects.js';
import { projectsListQueryKey } from '@/features/projects/api/projectsApi.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 * @returns {(props: { children: import('react').ReactNode }) => import('react').ReactElement}
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useProjects', () => {
  it('builds the list key and pages with cursor', async () => {
    listProjects.mockImplementation(async ({ cursor }) => {
      if (!cursor) {
        return {
          items: [{ id: '1', name: 'A' }],
          pageInfo: { nextCursor: 'c2', hasMore: true },
        };
      }
      return {
        items: [{ id: '2', name: 'B' }],
        pageInfo: { nextCursor: null, hasMore: false },
      };
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useProjects({ q: 'a', includeArchived: false, sort: 'updatedAt' }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'a', includeArchived: false, cursor: undefined }),
    );
    expect(projectsListQueryKey({ q: 'a' })[0]).toBe('projects');
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages?.length).toBe(2));
    expect(listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'c2' }),
    );
    expect(flattenProjectPages(result.current.data).map((p) => p.id)).toEqual(['1', '2']);
    expect(flattenProjectPages(undefined)).toEqual([]);
  });
});
