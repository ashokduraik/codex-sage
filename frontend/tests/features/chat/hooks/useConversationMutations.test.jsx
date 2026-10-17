/**
 * Conversation mutation invalidation and optimistic rename/archive.
 */
import { ApiError } from '@/shared/api/index';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { conversationsListQueryKey, conversationDetailQueryKey } from '@/features/chat/conversationQueryKeys.js';

vi.mock('@/features/chat/api/conversationsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    archiveConversation: vi.fn(),
    restoreConversation: vi.fn(),
    deleteConversation: vi.fn(),
  };
});

import {
  createConversation,
  deleteConversation,
  renameConversation,
  archiveConversation,
  restoreConversation,
} from '@/features/chat/api/conversationsApi.js';
import {
  useCreateConversation,
  useDeleteConversation,
  useRenameConversation,
  useArchiveConversation,
  useRestoreConversation,
} from '@/features/chat/hooks/useConversationMutations.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useConversationMutations', () => {
  it('invalidates lists on create success and surfaces errors', async () => {
    createConversation.mockResolvedValueOnce({ id: 'c1', title: 'New conversation' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ idempotencyKey: 'k1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalled();

    createConversation.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }));
    const { result: fail } = renderHook(() => useCreateConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    fail.current.mutate({ idempotencyKey: 'k2' });
    await waitFor(() => expect(fail.current.isError).toBe(true));
    expect(fail.current.error.message).toBe('nope');
  });

  it('rolls back rename title on failure', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const listKey = conversationsListQueryKey('p1', { archived: false });
    const detailKey = conversationDetailQueryKey('p1', 'c1');
    queryClient.setQueryData(listKey, {
      pages: [{ items: [{ id: 'c1', title: 'Old' }], nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(detailKey, { id: 'c1', title: 'Old' });

    renameConversation.mockRejectedValueOnce(new ApiError({ code: 'VALIDATION_ERROR', message: 'bad', status: 400 }));
    const { result } = renderHook(() => useRenameConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ conversationId: 'c1', title: 'New', previousTitle: 'Old' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(detailKey).title).toBe('Old');
    expect(queryClient.getQueryData(listKey).pages[0].items[0].title).toBe('Old');
  });

  it('optimistically removes from recent list and rolls back archive failure', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const recentKey = conversationsListQueryKey('p1', { archived: false });
    queryClient.setQueryData(recentKey, {
      pages: [{ items: [{ id: 'c1', title: 'A', lifecycleStatus: 'active' }], nextCursor: null }],
      pageParams: [undefined],
    });

    archiveConversation.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }));
    const { result } = renderHook(() => useArchiveConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(recentKey).pages[0].items).toHaveLength(1);
  });

  it('removes detail and messages caches on delete', async () => {
    deleteConversation.mockResolvedValueOnce(undefined);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const detailKey = conversationDetailQueryKey('p1', 'c1');
    queryClient.setQueryData(detailKey, { id: 'c1' });
    const removeSpy = vi.spyOn(queryClient, 'removeQueries');
    const { result } = renderHook(() => useDeleteConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(removeSpy).toHaveBeenCalled();
  });

  it('optimistically moves an archived row back to recent on restore', async () => {
    restoreConversation.mockResolvedValueOnce({ id: 'c1', lifecycleStatus: 'active' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const recentKey = conversationsListQueryKey('p1', { archived: false });
    const archivedKey = conversationsListQueryKey('p1', { archived: true });
    queryClient.setQueryData(archivedKey, {
      pages: [{ items: [{ id: 'c1', title: 'A', lifecycleStatus: 'archived' }], nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(recentKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    const { result } = renderHook(() => useRestoreConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(recentKey).pages[0].items.some((row) => row.id === 'c1')).toBe(true);
  });

  it('creates target list cache when restoring into a missing recent query', async () => {
    restoreConversation.mockResolvedValueOnce({ id: 'c1', lifecycleStatus: 'active' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const archivedKey = conversationsListQueryKey('p1', { archived: true });
    queryClient.setQueryData(archivedKey, {
      pages: [{ items: [{ id: 'c1', title: 'A', lifecycleStatus: 'archived' }], nextCursor: null }],
      pageParams: [undefined],
    });
    const { result } = renderHook(() => useRestoreConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const recentKey = conversationsListQueryKey('p1', { archived: false });
    expect(queryClient.getQueryData(recentKey).pages[0].items[0].id).toBe('c1');
  });

  it('moves an active conversation into the archived list on archive success', async () => {
    archiveConversation.mockResolvedValueOnce({ id: 'c1', lifecycleStatus: 'archived' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const recentKey = conversationsListQueryKey('p1', { archived: false });
    const archivedKey = conversationsListQueryKey('p1', { archived: true });
    queryClient.setQueryData(recentKey, {
      pages: [
        {
          items: [
            { id: 'c1', title: 'A', lifecycleStatus: 'active' },
            { id: 'c2', title: 'B', lifecycleStatus: 'active' },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    queryClient.setQueryData(archivedKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    const { result } = renderHook(() => useArchiveConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(recentKey).pages[0].items.map((row) => row.id)).toEqual(['c2']);
  });

  it('applies optimistic rename to detail and list caches', async () => {
    renameConversation.mockResolvedValueOnce({ id: 'c1', title: 'New' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const listKey = conversationsListQueryKey('p1', { archived: false });
    const detailKey = conversationDetailQueryKey('p1', 'c1');
    queryClient.setQueryData(listKey, {
      pages: [
        {
          items: [
            { id: 'c1', title: 'Old' },
            { id: 'c2', title: 'Other' },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    queryClient.setQueryData(detailKey, { id: 'c1', title: 'Old' });
    const { result } = renderHook(() => useRenameConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ conversationId: 'c1', title: 'New' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(detailKey).title).toBe('New');
  });

  it('no-ops optimistic move when the conversation is missing from list caches', async () => {
    archiveConversation.mockResolvedValueOnce({ id: 'missing', lifecycleStatus: 'archived' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const recentKey = conversationsListQueryKey('p1', { archived: false });
    queryClient.setQueryData(recentKey, {
      pages: [{ items: [{ id: 'c1', title: 'A', lifecycleStatus: 'active' }], nextCursor: null }],
      pageParams: [undefined],
    });
    const { result } = renderHook(() => useArchiveConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('missing');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(recentKey).pages[0].items).toHaveLength(1);
  });

  it('accepts empty project id for create invalidation paths', async () => {
    createConversation.mockResolvedValueOnce({ id: 'c1' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateConversation(''), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ idempotencyKey: 'k-empty' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('skips rename optimistic updates for list caches without pages or items arrays', async () => {
    renameConversation.mockResolvedValueOnce({ id: 'c1', title: 'New' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const listKey = conversationsListQueryKey('p1', { archived: false });
    const oddKey = ['conversations', 'list', 'p1', { archived: false, limit: 99 }];
    queryClient.setQueryData(listKey, {
      pages: [{ items: 'not-an-array', nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(oddKey, { notPages: true });
    const { result } = renderHook(() => useRenameConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ conversationId: 'c1', title: 'New' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('rolls back restore when the mutation fails with sparse caches', async () => {
    restoreConversation.mockRejectedValueOnce(new ApiError({ status: 409, code: 'INVALID_STATE_TRANSITION', message: 'nope' }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const archivedKey = conversationsListQueryKey('p1', { archived: true });
    queryClient.setQueryData(archivedKey, {
      pages: [{ items: [{ id: 'c1', title: 'A', lifecycleStatus: 'archived' }], nextCursor: null }],
      pageParams: [undefined],
    });
    // Non-pages list entry exercises restoreListCaches + skip paths.
    queryClient.setQueryData(['conversations', 'list', 'other'], { stale: true });
    const { result } = renderHook(() => useRestoreConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(archivedKey).pages[0].items).toHaveLength(1);
  });

  it('archives into a missing archived list by creating a target page', async () => {
    archiveConversation.mockResolvedValueOnce({ id: 'c1', lifecycleStatus: 'archived' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const recentKey = conversationsListQueryKey('p1', { archived: false });
    queryClient.setQueryData(recentKey, {
      pages: [{ items: [{ id: 'c1', title: 'A', lifecycleStatus: 'active' }], nextCursor: null }],
      pageParams: [undefined],
    });
    const { result } = renderHook(() => useArchiveConversation('p1'), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const archivedKey = conversationsListQueryKey('p1', { archived: true });
    expect(queryClient.getQueryData(archivedKey).pages[0].items[0].id).toBe('c1');
  });

  it('covers nullish project ids and sparse optimistic edge paths', async () => {
    createConversation.mockResolvedValueOnce({ id: 'c1' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result: createResult } = renderHook(() => useCreateConversation(undefined), {
      wrapper: createWrapper(queryClient),
    });
    createResult.current.mutate({ idempotencyKey: 'k-undef' });
    await waitFor(() => expect(createResult.current.isSuccess).toBe(true));

    renameConversation.mockRejectedValueOnce(new ApiError({ status: 400, code: 'VALIDATION_ERROR', message: 'bad' }));
    const { result: renameResult } = renderHook(() => useRenameConversation(null), {
      wrapper: createWrapper(queryClient),
    });
    renameResult.current.mutate({ conversationId: 'c9', title: 'X' });
    await waitFor(() => expect(renameResult.current.isError).toBe(true));

    archiveConversation.mockResolvedValueOnce({ id: 'c1', lifecycleStatus: 'archived' });
    // No source list cache — exercises sourceData?.pages false path.
    const { result: archiveResult } = renderHook(() => useArchiveConversation('p2'), {
      wrapper: createWrapper(queryClient),
    });
    archiveResult.current.mutate('c1');
    await waitFor(() => expect(archiveResult.current.isSuccess).toBe(true));

    archiveConversation.mockResolvedValueOnce({ id: 'c1', lifecycleStatus: 'archived' });
    const recentKey = conversationsListQueryKey('p3', { archived: false });
    const archivedKey = conversationsListQueryKey('p3', { archived: true });
    queryClient.setQueryData(recentKey, {
      pages: [{ items: [{ id: 'c1', title: 'A', lifecycleStatus: 'active' }], nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(archivedKey, {
      pages: [
        { items: 'bad', nextCursor: 'x' },
        { items: [{ id: 'old', title: 'Old', lifecycleStatus: 'archived' }], nextCursor: null },
      ],
      pageParams: [undefined, 'x'],
    });
    const { result: multiPage } = renderHook(() => useArchiveConversation('p3'), {
      wrapper: createWrapper(queryClient),
    });
    multiPage.current.mutate('c1');
    await waitFor(() => expect(multiPage.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(archivedKey).pages).toHaveLength(2);
  });
});
