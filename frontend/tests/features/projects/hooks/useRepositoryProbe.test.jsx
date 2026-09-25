/**
 * Repository probe mutation keeps the token out of React Query variables.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/projects/api/repositoriesApi.js', () => ({
  probeProjectRepository: vi.fn(),
}));

import { probeProjectRepository } from '@/features/projects/api/repositoriesApi.js';
import { useRepositoryProbe } from '@/features/projects/hooks/useRepositoryProbe.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useRepositoryProbe', () => {
  it('forwards the token to the API but not to mutation variables', async () => {
    probeProjectRepository.mockResolvedValue({ probeStatus: 'connected' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryProbe(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.probe({
        projectId: 'p1',
        repositoryUrl: 'https://github.com/acme/private',
        accessToken: 'secret-token',
      });
    });
    expect(probeProjectRepository).toHaveBeenCalledWith({
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/private',
      accessToken: 'secret-token',
      signal: undefined,
    });
    const variables = queryClient
      .getMutationCache()
      .getAll()
      .map((entry) => entry.state.variables);
    expect(JSON.stringify(variables)).not.toContain('secret-token');
  });

  it('omits accessToken when the caller did not provide one', async () => {
    probeProjectRepository.mockResolvedValue({ probeStatus: 'connected' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useRepositoryProbe(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.probe({
        projectId: 'p1',
        repositoryUrl: 'https://github.com/acme/atlas',
      });
    });
    expect(probeProjectRepository).toHaveBeenCalledWith({
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/atlas',
      accessToken: undefined,
      signal: undefined,
    });
  });
});
