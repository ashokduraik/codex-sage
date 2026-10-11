/**
 * Tests for retry/cancel mutations.
 */
import { ApiError } from '@/shared/api/index';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/projects/processing/api/jobsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    retryJob: vi.fn(),
    cancelJob: vi.fn(),
  };
});

import { useJobControl } from '@/features/projects/processing/hooks/useJobControl.js';
import { cancelJob, jobDetailQueryKey, projectJobsQueryRoot, retryJob } from '@/features/projects/processing/api/jobsApi.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useJobControl', () => {
  it('retries with an Idempotency-Key and invalidates caches', async () => {
    retryJob.mockResolvedValue({ jobId: 'j1', jobStatus: 'retrying' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useJobControl('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.retry('j1');
    });
    expect(retryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'j1',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: projectJobsQueryRoot('p1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobDetailQueryKey('j1') });
  });

  it('cancels and surfaces 409 INVALID_JOB_TRANSITION', async () => {
    cancelJob.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'INVALID_JOB_TRANSITION',
        message: 'cannot cancel',
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useJobControl('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await expect(
      act(async () => {
        await result.current.cancel('j1');
      }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION' });
    expect(cancelJob).toHaveBeenCalledWith({ jobId: 'j1' });
  });

  it('cancels successfully and can reset mutation errors', async () => {
    cancelJob.mockResolvedValue({
      jobId: 'j1',
      jobStatus: 'running',
      cancellation: { requested: true, requestedAt: '2026-01-02T00:00:00.000Z' },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useJobControl('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.cancel('j1');
    });
    expect(invalidateSpy).toHaveBeenCalled();
    act(() => {
      result.current.reset();
    });
    expect(result.current.cancelError).toBeNull();
  });
});
