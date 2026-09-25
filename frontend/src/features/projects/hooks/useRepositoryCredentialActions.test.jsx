/**
 * Credential replace / revoke / re-test mutations.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api';

vi.mock('@/features/projects/api/repositoriesApi.js', () => ({
  repositoryConnectionQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'repositories', 'connection']),
  replaceProjectRepositoryCredential: vi.fn(),
  revokeProjectRepositoryCredential: vi.fn(),
  retestProjectRepositoryConnection: vi.fn(),
}));

vi.mock('@/features/projects/api/sourcesApi.js', () => ({
  sourceVersionsQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'source-versions']),
}));

import {
  replaceProjectRepositoryCredential,
  revokeProjectRepositoryCredential,
  retestProjectRepositoryConnection,
} from '@/features/projects/api/repositoriesApi.js';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';
import { useRepositoryCredentialActions } from './useRepositoryCredentialActions.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useRepositoryCredentialActions', () => {
  it('replaces a token without leaving it on the mutation and invalidates queries', async () => {
    replaceProjectRepositoryCredential.mockResolvedValue({
      connection: { id: 'c1' },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRepositoryCredentialActions('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.replace('secret-token');
    });
    expect(replaceProjectRepositoryCredential).toHaveBeenCalledWith({
      projectId: 'p1',
      accessToken: 'secret-token',
    });
    expect(result.current.replaceError).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['projects', 'p1', 'repositories', 'connection'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['projects', 'p1', 'source-versions'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectDetailQueryKey('p1'),
    });
  });

  it('surfaces 403 on revoke', async () => {
    revokeProjectRepositoryCredential.mockRejectedValue(
      new ApiError({ status: 403, code: 'FORBIDDEN', message: 'nope' }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryCredentialActions('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await expect(
      act(async () => {
        await result.current.revoke();
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await waitFor(() => {
      expect(result.current.revokeError).toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  it('re-tests the live connection', async () => {
    retestProjectRepositoryConnection.mockResolvedValue({
      connectionStatus: 'connected',
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryCredentialActions('p1'), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.retest();
    });
    expect(retestProjectRepositoryConnection).toHaveBeenCalledWith({
      projectId: 'p1',
    });
  });
});
