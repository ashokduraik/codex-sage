/**
 * Repository attach mutation seeds connection cache and strips the token.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/projects/api/repositoriesApi.js', () => ({
  attachProjectRepository: vi.fn(),
  repositoryConnectionQueryKey: (projectId) => Object.freeze(['projects', String(projectId), 'repositories', 'connection']),
}));

import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';
import { useRepositoryAttach } from '@/features/projects/hooks/useRepositoryAttach.js';
import { attachProjectRepository, repositoryConnectionQueryKey } from '@/features/projects/api/repositoriesApi.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useRepositoryAttach', () => {
  it('invalidates project detail and omits the token from cache', async () => {
    const payload = { connection: { id: 'c1', selectedBranch: 'main' } };
    attachProjectRepository.mockResolvedValue(payload);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRepositoryAttach(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.attach({
        projectId: 'p1',
        repositoryUrl: 'https://github.com/acme/atlas',
        selectedBranch: 'main',
        accessToken: 'secret-token',
        idempotencyKey: 'idem-1',
      });
    });
    expect(attachProjectRepository).toHaveBeenCalledWith({
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/atlas',
      selectedBranch: 'main',
      idempotencyKey: 'idem-1',
      signal: undefined,
      accessToken: 'secret-token',
    });
    expect(queryClient.getQueryData(repositoryConnectionQueryKey('p1'))).toEqual(payload);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectDetailQueryKey('p1'),
    });
    const variables = queryClient
      .getMutationCache()
      .getAll()
      .map((entry) => entry.state.variables);
    expect(JSON.stringify(variables)).not.toContain('secret-token');
  });

  it('skips cache seed when the attach payload has no connection', async () => {
    attachProjectRepository.mockResolvedValue({});
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryAttach(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.attach({
        projectId: 'p1',
        repositoryUrl: 'https://github.com/acme/atlas',
        selectedBranch: 'main',
        idempotencyKey: 'idem-2',
      });
    });
    expect(queryClient.getQueryData(repositoryConnectionQueryKey('p1'))).toBeUndefined();
  });
});
