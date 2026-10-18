/**
 * useProject detail query — polls while ingest/rebuild can still mutate the project.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProject: vi.fn(),
  };
});

import { getProject } from '@/features/projects/api/projectsApi.js';
import { PROJECT_DETAIL_POLL_INTERVAL_MS, useProject } from '@/features/projects/hooks/useProject.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 * @returns {(props: { children: import('react').ReactNode }) => import('react').ReactElement}
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useProject', () => {
  it('polls while lifecycle is processing and stops when knowledge is ready', async () => {
    getProject.mockReset();
    getProject
      .mockResolvedValueOnce({
        id: 'p1',
        name: 'Atlas',
        description: '',
        lifecycleStatus: 'processing',
        knowledgeHealth: 'updating',
      })
      .mockResolvedValueOnce({
        id: 'p1',
        name: 'Atlas',
        description: '',
        lifecycleStatus: 'knowledge_ready',
        knowledgeHealth: 'ready',
      });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useProject('p1'), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.lifecycleStatus).toBe('processing');

    await waitFor(
      () => {
        expect(result.current.data?.lifecycleStatus).toBe('knowledge_ready');
        expect(result.current.data?.knowledgeHealth).toBe('ready');
      },
      { timeout: PROJECT_DETAIL_POLL_INTERVAL_MS + 2000 },
    );
    expect(getProject.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not poll when lifecycle is already terminal', async () => {
    getProject.mockReset();
    getProject.mockResolvedValue({
      id: 'p1',
      name: 'Atlas',
      description: 'Already set',
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useProject('p1'), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const callsAfterSuccess = getProject.mock.calls.length;
    await new Promise((resolve) => {
      setTimeout(resolve, PROJECT_DETAIL_POLL_INTERVAL_MS + 500);
    });
    expect(getProject.mock.calls.length).toBe(callsAfterSuccess);
  });
});
