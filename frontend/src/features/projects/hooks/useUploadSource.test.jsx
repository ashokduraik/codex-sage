/**
 * Tests for the source upload mutation hook.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api';

vi.mock('@/features/projects/api/sourcesApi.js', () => ({
  uploadProjectSource: vi.fn(),
  sourceVersionsQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'source-versions']),
}));

import { uploadProjectSource } from '@/features/projects/api/sourcesApi.js';
import { useUploadSource } from './useUploadSource.js';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useUploadSource', () => {
  it('tracks monotonic progress and invalidates the project on success', async () => {
    uploadProjectSource.mockImplementation(async (input) => {
      input.onUploadProgress({ loaded: 5, total: 10 });
      input.onUploadProgress({ loaded: 3, total: 10 });
      input.onUploadProgress({ loaded: 10, total: 10 });
      return { sourceVersionId: 'sv1', jobId: 'j1' };
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUploadSource(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        file: new File(['x'], 'a.zip'),
        idempotencyKey: 'idem-1',
      });
    });
    expect(result.current.progress).toEqual({ loaded: 10, total: 10 });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectDetailQueryKey('p1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['projects', 'p1', 'source-versions'],
    });
    act(() => {
      result.current.resetProgress();
    });
    expect(result.current.progress).toEqual({ loaded: 0, total: 0 });
  });

  it('surfaces 409 IDEMPOTENCY_IN_FLIGHT as an ApiError', async () => {
    uploadProjectSource.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'IDEMPOTENCY_IN_FLIGHT',
        message: 'still going',
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useUploadSource(), {
      wrapper: createWrapper(queryClient),
    });
    await expect(
      result.current.mutateAsync({
        projectId: 'p1',
        file: new File(['x'], 'a.zip'),
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_FLIGHT' });
    await waitFor(() => {
      expect(result.current.error).toMatchObject({ code: 'IDEMPOTENCY_IN_FLIGHT' });
    });
  });
});
