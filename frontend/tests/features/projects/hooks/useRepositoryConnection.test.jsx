/**
 * Repository connection query treats 404 as no connection.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api/index';

vi.mock('@/features/projects/api/repositoriesApi.js', () => ({
  repositoryConnectionQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'repositories', 'connection']),
  getProjectRepositoryConnection: vi.fn(),
}));

import { getProjectRepositoryConnection } from '@/features/projects/api/repositoriesApi.js';
import { useRepositoryConnection } from '@/features/projects/hooks/useRepositoryConnection.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useRepositoryConnection', () => {
  it('does not fetch when projectId is missing', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHook(() => useRepositoryConnection(null), {
      wrapper: createWrapper(queryClient),
    });
    expect(getProjectRepositoryConnection).not.toHaveBeenCalled();
  });

  it('returns the connection payload', async () => {
    getProjectRepositoryConnection.mockResolvedValue({
      connection: { id: 'c1' },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryConnection('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.data).toEqual({ connection: { id: 'c1' } });
    });
  });

  it('maps 404 NOT_FOUND to a null connection', async () => {
    getProjectRepositoryConnection.mockRejectedValue(
      new ApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryConnection('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.data).toEqual({ connection: null });
    });
    expect(result.current.isError).toBe(false);
  });

  it('rethrows non-404 errors', async () => {
    getProjectRepositoryConnection.mockRejectedValue(
      new ApiError({ status: 500, code: 'SYSTEM_ERROR', message: 'boom' }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryConnection('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toMatchObject({ code: 'SYSTEM_ERROR' });
  });
});
