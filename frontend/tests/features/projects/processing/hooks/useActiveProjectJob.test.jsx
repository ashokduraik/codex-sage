/**
 * Tests for selecting the header/overview active job.
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
import { useActiveProjectJob } from '@/features/projects/processing/hooks/useActiveProjectJob.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useActiveProjectJob', () => {
  it('returns the running job when the list includes one', async () => {
    listProjectJobs.mockResolvedValue({
      items: [
        { id: 'done', jobStatus: 'completed', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'run', jobStatus: 'running', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useActiveProjectJob('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.activeJob?.id).toBe('run');
    });
  });

  it('returns null when every job is terminal', async () => {
    listProjectJobs.mockResolvedValue({
      items: [{ id: 'done', jobStatus: 'failed', createdAt: '2026-01-01T00:00:00.000Z' }],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useActiveProjectJob('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.activeJob).toBeNull();
  });
});
