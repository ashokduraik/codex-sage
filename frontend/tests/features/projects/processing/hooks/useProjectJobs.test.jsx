/**
 * Tests for the project jobs infinite query.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/projects/processing/api/jobsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjectJobs: vi.fn(),
  };
});

import { listProjectJobs } from '@/features/projects/processing/api/jobsApi.js';
import { flattenJobPages, useProjectJobs } from '@/features/projects/processing/hooks/useProjectJobs.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useProjectJobs', () => {
  it('loads the first page and flattens items', async () => {
    listProjectJobs.mockResolvedValue({
      items: [{ id: 'j1', jobStatus: 'completed' }],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useProjectJobs('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(flattenJobPages(result.current.data)).toEqual([{ id: 'j1', jobStatus: 'completed' }]);
    expect(listProjectJobs).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }));
  });

  it('does not fetch when projectId is missing', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useProjectJobs(''), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('exposes the next cursor when the page has more', async () => {
    listProjectJobs.mockResolvedValue({
      items: [{ id: 'j1', jobStatus: 'completed' }],
      pageInfo: { nextCursor: 'c1', hasMore: true },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useProjectJobs('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(true);
    });
    expect(flattenJobPages(undefined)).toEqual([]);
  });
});
