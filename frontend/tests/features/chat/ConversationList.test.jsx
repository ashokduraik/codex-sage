/**
 * ConversationList against mocked conversation APIs.
 */
import { ApiError } from '@/shared/api/index';
import { ConversationList } from '@/features/chat/ConversationList';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

const listConversations = vi.fn();
const searchConversations = vi.fn();
const renameConversation = vi.fn();
const archiveConversation = vi.fn();
const restoreConversation = vi.fn();
const deleteConversation = vi.fn();

vi.mock('@/features/chat/api/conversationsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listConversations: (...args) => listConversations(...args),
    searchConversations: (...args) => searchConversations(...args),
    renameConversation: (...args) => renameConversation(...args),
    archiveConversation: (...args) => archiveConversation(...args),
    restoreConversation: (...args) => restoreConversation(...args),
    deleteConversation: (...args) => deleteConversation(...args),
  };
});

const ACTIVE = [
  {
    id: 'conv_1',
    title: 'How does authentication work?',
    lifecycleStatus: 'active',
    messageCount: 2,
    lastMessageAt: '2026-09-11T12:00:00Z',
    updatedAt: '2026-09-11T12:00:00Z',
  },
  {
    id: 'conv_2',
    title: 'Where is payment implemented?',
    lifecycleStatus: 'active',
    messageCount: 1,
    lastMessageAt: '2026-09-10T12:00:00Z',
    updatedAt: '2026-09-10T12:00:00Z',
  },
];

const ARCHIVED = [
  {
    id: 'conv_3',
    title: 'Checkout flow walkthrough',
    lifecycleStatus: 'archived',
    messageCount: 4,
    lastMessageAt: '2026-08-01T12:00:00Z',
    updatedAt: '2026-08-01T12:00:00Z',
  },
];

afterEach(() => {
  cleanup();
  listConversations.mockReset();
  searchConversations.mockReset();
  renameConversation.mockReset();
  archiveConversation.mockReset();
  restoreConversation.mockReset();
  deleteConversation.mockReset();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession('you@acme.io', {
    permissions: ['chat.ask', 'conversations.search', 'conversations.archive'],
  });
  listConversations.mockImplementation(async (_projectId, options = {}) => {
    if (options.archived) {
      return { items: ARCHIVED, nextCursor: null };
    }
    return { items: ACTIVE, nextCursor: null };
  });
  searchConversations.mockResolvedValue({ items: [], nextCursor: null });
});

describe('ConversationList', () => {
  it('lists conversations and notifies on select and new chat', async () => {
    const onSelect = vi.fn();
    const onNew = vi.fn();
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId="conv_1" onSelect={onSelect} onNew={onNew} />);
    expect(await screen.findByText('How does authentication work?')).toBeTruthy();
    expect(screen.getByText('Where is payment implemented?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
    expect(onNew).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Where is payment implemented?'));
    expect(onSelect).toHaveBeenCalledWith('conv_2');
  });

  it('searches via backend and shows dedicated empty state', async () => {
    searchConversations.mockResolvedValue({ items: [], nextCursor: null });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    fireEvent.change(screen.getByPlaceholderText('Search conversations'), {
      target: { value: 'zzzz-no-match' },
    });
    await waitFor(() => {
      expect(screen.getByText('No conversations match your search.')).toBeTruthy();
    });
    expect(searchConversations).toHaveBeenCalled();
  });

  it('shows archived conversations and empty recent state', async () => {
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    listConversations.mockImplementation(async (_projectId, options = {}) => {
      if (options.archived) {
        return { items: [], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    await waitFor(() => {
      expect(screen.getByText('No archived conversations.')).toBeTruthy();
    });
  });

  it('shows list error with retry', async () => {
    listConversations.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' }));
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('hides search without conversations.search permission', async () => {
    seedAuthSession('you@acme.io', { permissions: ['chat.ask'] });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    expect(screen.queryByPlaceholderText('Search conversations')).toBeNull();
  });

  it('renders unknown lifecycleStatus without crashing', async () => {
    listConversations.mockResolvedValue({
      items: [
        {
          id: 'conv_x',
          title: 'Odd status',
          lifecycleStatus: 'something_new',
          messageCount: 0,
          lastMessageAt: null,
          updatedAt: '2026-09-11T12:00:00Z',
        },
      ],
      nextCursor: null,
    });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByText('Odd status')).toBeTruthy();
  });

  it('shows action menus for listed conversations', async () => {
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId="conv_1" onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    expect(screen.getAllByLabelText('Actions').length).toBeGreaterThan(0);
  });

  it('renders search hits and selects them', async () => {
    searchConversations.mockResolvedValue({
      items: [
        {
          id: 'conv_2',
          title: 'Where is payment implemented?',
          snippet: 'stripe checkout',
          updatedAt: '2026-09-10T12:00:00Z',
        },
      ],
      nextCursor: null,
    });
    const onSelect = vi.fn();
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={onSelect} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    fireEvent.change(screen.getByPlaceholderText('Search conversations'), {
      target: { value: 'payment' },
    });
    expect(await screen.findByText('stripe checkout')).toBeTruthy();
    fireEvent.click(screen.getByText('Where is payment implemented?'));
    expect(onSelect).toHaveBeenCalledWith('conv_2');
  });

  it('deletes the active conversation after confirm and clears selection', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteConversation.mockResolvedValue(undefined);
    const onSelect = vi.fn();
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId="conv_1" onSelect={onSelect} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    openActionsMenu(0);
    const deleteItem = await screen.findByRole('menuitem', { name: /Delete/i });
    fireEvent.click(deleteItem);
    await waitFor(() => {
      expect(deleteConversation).toHaveBeenCalledWith('prj_atlas', 'conv_1');
    });
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(null);
    });
    confirmSpy.mockRestore();
  });

  it('loads the next page when Load more is available', async () => {
    listConversations
      .mockResolvedValueOnce({
        items: ACTIVE,
        nextCursor: 'next-1',
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'conv_4',
            title: 'Older thread',
            lifecycleStatus: 'active',
            messageCount: 0,
            lastMessageAt: null,
            updatedAt: '2026-07-01T12:00:00Z',
          },
        ],
        nextCursor: null,
      });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Older thread')).toBeTruthy();
  });

  it('renames a conversation from the menu', async () => {
    renameConversation.mockResolvedValue({ id: 'conv_1', title: 'Renamed auth' });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId="conv_1" onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    openActionsMenu(0);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/i }));
    const input = await screen.findByDisplayValue('How does authentication work?');
    fireEvent.change(input, { target: { value: 'Renamed auth' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(renameConversation).toHaveBeenCalledWith('prj_atlas', 'conv_1', { title: 'Renamed auth' });
    });
  });

  it('archives and restores conversations from the menu', async () => {
    archiveConversation.mockResolvedValue({ id: 'conv_1', lifecycleStatus: 'archived' });
    restoreConversation.mockResolvedValue({ id: 'conv_3', lifecycleStatus: 'active' });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId="conv_1" onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    openActionsMenu(0);
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Archive$/i }));
    await waitFor(() => {
      expect(archiveConversation).toHaveBeenCalledWith('prj_atlas', 'conv_1');
    });

    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    expect(await screen.findByText('Checkout flow walkthrough')).toBeTruthy();
    openActionsMenu(0);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Restore/i }));
    await waitFor(() => {
      expect(restoreConversation).toHaveBeenCalledWith('prj_atlas', 'conv_3');
    });
  });

  it('surfaces rename and search errors', async () => {
    renameConversation.mockRejectedValue(new ApiError({ status: 400, code: 'VALIDATION_ERROR', message: 'bad title' }));
    searchConversations.mockRejectedValue(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'search boom' }));
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId="conv_1" onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    openActionsMenu(0);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/i }));
    const input = await screen.findByDisplayValue('How does authentication work?');
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.blur(input);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('bad title')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search conversations'), {
      target: { value: 'payment' },
    });
    expect(await screen.findByText('search boom')).toBeTruthy();
  });

  it('retries list and search failures', async () => {
    listConversations
      .mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'list boom' }))
      .mockResolvedValue({ items: ACTIVE, nextCursor: null });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByText('list boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('How does authentication work?')).toBeTruthy();

    searchConversations
      .mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'search again' }))
      .mockResolvedValue({ items: [], nextCursor: null });
    fireEvent.change(screen.getByPlaceholderText('Search conversations'), {
      target: { value: 'auth' },
    });
    expect(await screen.findByText('search again')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  });

  it('renders untitled conversations and ignores empty rename commits', async () => {
    listConversations.mockResolvedValue({
      items: [
        {
          id: 'conv_blank',
          title: '',
          lifecycleStatus: 'active',
          messageCount: 0,
          lastMessageAt: null,
          updatedAt: '2026-09-11T12:00:00Z',
        },
      ],
      nextCursor: null,
    });
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId={null} onSelect={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByText('Untitled conversation')).toBeTruthy();
    openActionsMenu(0);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/i }));
    const input = await screen.findByDisplayValue('');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(renameConversation).not.toHaveBeenCalled();
  });

  it('cancels delete when confirm is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<ConversationList projectId="prj_atlas" activeConvId="conv_1" onSelect={() => undefined} onNew={() => undefined} />);
    await screen.findByText('How does authentication work?');
    openActionsMenu(0);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/i }));
    expect(deleteConversation).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

/**
 * Opens a Radix actions dropdown for a conversation row.
 * @param {number} index Actions button index.
 */
function openActionsMenu(index) {
  const actionButtons = screen.getAllByLabelText('Actions');
  fireEvent.pointerDown(actionButtons[index], { button: 0 });
  fireEvent.click(actionButtons[index]);
}
