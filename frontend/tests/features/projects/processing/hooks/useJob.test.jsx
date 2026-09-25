/**
 * Tests for job detail polling.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/projects/processing/api/jobsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getJob: vi.fn(),
  };
});

import { getJob, JOB_DETAIL_POLL_INTERVAL_MS } from '@/features/projects/processing/api/jobsApi.js';
import { useJob } from '@/features/projects/processing/hooks/useJob.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useJob', () => {
  it('polls while running and disables the interval when terminal', async () => {
    getJob.mockResolvedValue({ id: 'j1', jobStatus: 'completed', percent: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useJob('j1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data.jobStatus).toBe('completed');
    const interval = result.current.options
      ? undefined
      : queryClient.getQueryCache().find({ queryKey: ['jobs', 'detail', 'j1'] })
          ?.options.refetchInterval;
    const resolved =
      typeof interval === 'function'
        ? interval({ state: { data: { jobStatus: 'completed' } } })
        : interval;
    expect(resolved).toBe(false);
    const runningInterval = typeof interval === 'function'
      ? interval({ state: { data: { jobStatus: 'running' } } })
      : interval;
    expect(runningInterval).toBe(JOB_DETAIL_POLL_INTERVAL_MS);
  });
});
