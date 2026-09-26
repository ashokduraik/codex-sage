/**
 * Tests for the reingest mutation hook.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api/index';

vi.mock('@/features/projects/api/sourcesApi.js', () => ({
  reingestProjectSource: vi.fn(),
  sourceVersionsQueryKey: (projectId) => Object.freeze(['projects', String(projectId), 'source-versions']),
}));

import { reingestProjectSource } from '@/features/projects/api/sourcesApi.js';
import { useReingestSource } from '@/features/projects/hooks/useReingestSource.js';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';
import { projectJobsQueryRoot } from '@/features/projects/processing/api/jobsApi.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useReingestSource', () => {
  it('invalidates project, versions, and jobs on success', async () => {
    reingestProjectSource.mockResolvedValue({ jobId: 'j1', sourceVersionId: 'sv1', jobType: 'reingest' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useReingestSource(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        sourceVersionId: 'sv1',
        idempotencyKey: 'idem-1',
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectDetailQueryKey('p1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectJobsQueryRoot('p1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['projects', 'p1', 'source-versions'],
    });
  });

  it('surfaces 403 as an ApiError', async () => {
    reingestProjectSource.mockRejectedValue(
      new ApiError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'nope',
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useReingestSource(), {
      wrapper: createWrapper(queryClient),
    });
    await expect(
      result.current.mutateAsync({
        projectId: 'p1',
        sourceVersionId: 'sv1',
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
