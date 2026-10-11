/**
 * Project mutation invalidation and optimistic archive.
 */
import { ApiError } from '@/shared/api/index';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
  };
});

import { projectDetailQueryKey, projectsListQueryKey } from '@/features/projects/api/projectsApi.js';
import { archiveProject, createProject, deleteProject, restoreProject } from '@/features/projects/api/projectsApi.js';
import { useArchiveProject, useCreateProject, useDeleteProject, useRestoreProject } from '@/features/projects/hooks/useProjectMutations.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useProjectMutations', () => {
  it('invalidates lists on create success and surfaces errors', async () => {
    createProject.mockResolvedValueOnce({ id: 'p1', name: 'A' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateProject(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({
      name: 'A',
      sourceType: 'upload',
      idempotencyKey: 'k1',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalled();

    createProject.mockRejectedValueOnce(new ApiError({ code: 'PROJECT_NAME_TAKEN', message: 'taken', status: 409 }));
    const { result: fail } = renderHook(() => useCreateProject(), {
      wrapper: createWrapper(queryClient),
    });
    fail.current.mutate({
      name: 'A',
      sourceType: 'upload',
      idempotencyKey: 'k2',
    });
    await waitFor(() => expect(fail.current.isError).toBe(true));
    expect(fail.current.error.message).toBe('taken');
  });

  it('optimistically removes from non-archived lists and rolls back on error', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const listKey = projectsListQueryKey({ includeArchived: false });
    queryClient.setQueryData(listKey, {
      pages: [{ items: [{ id: 'p1', name: 'A', lifecycleStatus: 'awaiting_source' }], pageInfo: {} }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(projectDetailQueryKey('p1'), {
      id: 'p1',
      lifecycleStatus: 'awaiting_source',
    });

    archiveProject.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }));
    const { result } = renderHook(() => useArchiveProject(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('p1');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(listKey).pages[0].items).toHaveLength(1);
    expect(queryClient.getQueryData(projectDetailQueryKey('p1')).lifecycleStatus).toBe('awaiting_source');
  });

  it('marks archived items in includeArchived lists on successful archive', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const archivedListKey = projectsListQueryKey({ includeArchived: true });
    const activeListKey = projectsListQueryKey({ includeArchived: false });
    queryClient.setQueryData(archivedListKey, {
      pages: [
        {
          items: [
            { id: 'p1', name: 'A', lifecycleStatus: 'awaiting_source' },
            { id: 'p2', name: 'B', lifecycleStatus: 'awaiting_source' },
          ],
          pageInfo: {},
        },
      ],
      pageParams: [undefined],
    });
    queryClient.setQueryData(activeListKey, {
      pages: [
        {
          items: [
            { id: 'p1', name: 'A', lifecycleStatus: 'awaiting_source' },
            { id: 'p2', name: 'B', lifecycleStatus: 'awaiting_source' },
          ],
          pageInfo: {},
        },
      ],
      pageParams: [undefined],
    });
    queryClient.setQueryData(projectDetailQueryKey('p1'), {
      id: 'p1',
      lifecycleStatus: 'awaiting_source',
    });
    // Non-infinite cache entry should be skipped by optimistic helper.
    queryClient.setQueryData(projectsListQueryKey({ includeArchived: false, q: 'x' }), {
      items: [],
    });
    // Page without items array exercises the Array.isArray guard.
    queryClient.setQueryData(projectsListQueryKey({ includeArchived: true, q: 'y' }), {
      pages: [{ pageInfo: {} }],
      pageParams: [undefined],
    });

    archiveProject.mockResolvedValueOnce({ id: 'p1', lifecycleStatus: 'archived' });
    const { result } = renderHook(() => useArchiveProject(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('p1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(archivedListKey).pages[0].items[0].lifecycleStatus).toBe('archived');
    expect(queryClient.getQueryData(activeListKey).pages[0].items.map((item) => item.id)).toEqual(['p2']);
  });

  it('optimistically archives when detail cache is empty', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const listKey = projectsListQueryKey({ includeArchived: false });
    queryClient.setQueryData(listKey, {
      pages: [{ items: [{ id: 'p1', name: 'A', lifecycleStatus: 'awaiting_source' }], pageInfo: {} }],
      pageParams: [undefined],
    });
    archiveProject.mockResolvedValueOnce({ id: 'p1', lifecycleStatus: 'archived' });
    const { result } = renderHook(() => useArchiveProject(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('p1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(listKey).pages[0].items).toHaveLength(0);
  });

  it('rolls back archive when context has no previous detail', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const listKey = projectsListQueryKey({ includeArchived: false });
    queryClient.setQueryData(listKey, {
      pages: [{ items: [{ id: 'p1', name: 'A', lifecycleStatus: 'awaiting_source' }], pageInfo: {} }],
      pageParams: [undefined],
    });
    archiveProject.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }));
    const { result } = renderHook(() => useArchiveProject(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('p1');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(listKey).pages[0].items).toHaveLength(1);
  });

  it('restores and deletes invalidate caches', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    restoreProject.mockResolvedValueOnce({ id: 'p1', lifecycleStatus: 'awaiting_source' });
    deleteProject.mockResolvedValueOnce(undefined);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result: restore } = renderHook(() => useRestoreProject(), {
      wrapper: createWrapper(queryClient),
    });
    restore.current.mutate('p1');
    await waitFor(() => expect(restore.current.isSuccess).toBe(true));

    queryClient.setQueryData(projectDetailQueryKey('p1'), { id: 'p1' });
    const { result: del } = renderHook(() => useDeleteProject(), {
      wrapper: createWrapper(queryClient),
    });
    del.current.mutate('p1');
    await waitFor(() => expect(del.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(projectDetailQueryKey('p1'))).toBeUndefined();
    expect(invalidateSpy).toHaveBeenCalled();
  });
});
