/**
 * ChatWorkspace shell against mocked conversation APIs (no streaming).
 */
import { ApiError } from '@/shared/api/index';
import { Route, Routes } from 'react-router-dom';
import ChatWorkspace from '@/features/chat/ChatWorkspace';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

const listConversations = vi.fn();
const getConversation = vi.fn();
const listConversationMessages = vi.fn();
const createConversation = vi.fn();
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
    getConversation: (...args) => getConversation(...args),
    listConversationMessages: (...args) => listConversationMessages(...args),
    createConversation: (...args) => createConversation(...args),
    searchConversations: (...args) => searchConversations(...args),
    renameConversation: (...args) => renameConversation(...args),
    archiveConversation: (...args) => archiveConversation(...args),
    restoreConversation: (...args) => restoreConversation(...args),
    deleteConversation: (...args) => deleteConversation(...args),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession('you@acme.io', {
    permissions: ['chat.ask', 'conversations.search', 'conversations.archive'],
  });
  Element.prototype.scrollTo = vi.fn();
  listConversations.mockResolvedValue({
    items: [
      {
        id: 'conv_1',
        title: 'How does authentication work?',
        lifecycleStatus: 'active',
        messageCount: 2,
        lastMessageAt: '2026-09-11T12:00:00Z',
        updatedAt: '2026-09-11T12:00:00Z',
      },
    ],
    nextCursor: null,
  });
  getConversation.mockResolvedValue({
    id: 'conv_1',
    projectId: 'prj_atlas',
    title: 'How does authentication work?',
    titleSource: 'user',
    lifecycleStatus: 'active',
    ownerUserId: 'u_test',
    messageCount: 2,
    lastMessageAt: '2026-09-11T12:00:00Z',
    archivedAt: null,
    createdAt: '2026-09-11T11:00:00Z',
    updatedAt: '2026-09-11T12:00:00Z',
  });
  listConversationMessages.mockResolvedValue({
    items: [
      {
        id: 'm1',
        role: 'user',
        content: 'How does authentication work in this project?',
        messageStatus: 'completed',
        createdAt: '2026-09-11T11:00:00Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'JWT-based session tokens.',
        messageStatus: 'completed',
        createdAt: '2026-09-11T11:01:00Z',
      },
    ],
    nextCursor: null,
  });
  searchConversations.mockResolvedValue({ items: [], nextCursor: null });
  createConversation.mockResolvedValue({
    id: 'conv_new',
    projectId: 'prj_atlas',
    title: 'New conversation',
    titleSource: 'default',
    lifecycleStatus: 'active',
    ownerUserId: 'u_test',
    messageCount: 0,
    lastMessageAt: null,
    archivedAt: null,
    createdAt: '2026-09-11T12:00:00Z',
    updatedAt: '2026-09-11T12:00:00Z',
  });
});

/**
 * Renders chat inside the project detail outlet.
 * @param {string} route Route including optional query.
 */
function renderChat(route = '/projects/prj_atlas/chat') {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />}>
        <Route path="chat" element={<ChatWorkspace />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('ChatWorkspace', () => {
  it('loads messages for ?conv= and keeps the composer disabled', async () => {
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    expect(await screen.findByText(/How does authentication work in this project/i)).toBeTruthy();
    expect(screen.getByText(/JWT-based session/i)).toBeTruthy();
    const input = screen.getByPlaceholderText(/Sending answers connects/i);
    expect(input.disabled).toBe(true);
  });

  it('creates a conversation from New Chat', async () => {
    renderChat('/projects/prj_atlas/chat');
    await screen.findByText('How does authentication work?');
    fireEvent.click(screen.getAllByRole('button', { name: 'New Chat' })[0]);
    await waitFor(() => {
      expect(createConversation).toHaveBeenCalledWith('prj_atlas', expect.objectContaining({ idempotencyKey: expect.any(String) }));
    });
  });

  it('shows forbidden copy on detail 403', async () => {
    getConversation.mockRejectedValue(new ApiError({ status: 403, code: 'FORBIDDEN', message: 'no' }));
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    expect(await screen.findByText(/do not have access/i)).toBeTruthy();
  });

  it('shows not-found copy on detail 404', async () => {
    getConversation.mockRejectedValue(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' }));
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    expect(await screen.findByText(/was not found/i)).toBeTruthy();
  });

  it('opens mobile history without horizontal overflow', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    await screen.findByText(/JWT-based session/i);
    fireEvent.click(screen.getByLabelText('Open conversation history'));
    expect(screen.getAllByText('How does authentication work?').length).toBeGreaterThan(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  });

  it('shows create failure alert', async () => {
    createConversation.mockRejectedValue(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'create boom' }));
    renderChat('/projects/prj_atlas/chat');
    await screen.findByText('How does authentication work?');
    fireEvent.click(screen.getAllByRole('button', { name: 'New Chat' })[0]);
    expect(await screen.findByText('create boom')).toBeTruthy();
  });

  it('shows message load failure with retry', async () => {
    listConversationMessages.mockRejectedValue(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'msgs boom' }));
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    expect(await screen.findByText('msgs boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows empty thread copy when conversation has no messages', async () => {
    listConversationMessages.mockResolvedValue({ items: [], nextCursor: null });
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    expect(await screen.findByText(/Ask anything about Atlas Commerce/i)).toBeTruthy();
    expect(screen.getByText(/browse history now/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/Sending answers connects/i)).toBeTruthy();
  });

  it('clears selection when handleSelect receives null via delete flow', async () => {
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    await screen.findByText(/JWT-based session/i);
    fireEvent.click(screen.getAllByRole('button', { name: 'New Chat' })[0]);
    await waitFor(() => {
      expect(createConversation).toHaveBeenCalled();
    });
  });

  it('retries failed conversation detail', async () => {
    getConversation.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'detail boom' })).mockResolvedValueOnce({
      id: 'conv_1',
      projectId: 'prj_atlas',
      title: 'How does authentication work?',
      titleSource: 'user',
      lifecycleStatus: 'active',
      ownerUserId: 'u_test',
      messageCount: 2,
      lastMessageAt: '2026-09-11T12:00:00Z',
      archivedAt: null,
      createdAt: '2026-09-11T11:00:00Z',
      updatedAt: '2026-09-11T12:00:00Z',
    });
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    expect(await screen.findByText('detail boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/JWT-based session/i)).toBeTruthy();
  });

  it('closes the mobile history drawer via backdrop', async () => {
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    await screen.findByText(/JWT-based session/i);
    fireEvent.click(screen.getByLabelText('Open conversation history'));
    expect(screen.getAllByText('How does authentication work?').length).toBeGreaterThan(0);
    const backdrop = document.querySelector('.bg-black\\/30');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
  });

  it('shows knowledge updating banner and not-askable placeholder for updating projects', async () => {
    const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
    fixtures.defaultProjectsApiMock.getProject.mockResolvedValueOnce(fixtures.HELIOS_API_PROJECT);
    listConversations.mockResolvedValue({ items: [], nextCursor: null });
    renderChat('/projects/prj_helios/chat');
    expect(await screen.findByText(/Knowledge is updating/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/not ready for questions/i)).toBeTruthy();
  });

  it('retries failed messages', async () => {
    listConversationMessages
      .mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'msgs boom' }))
      .mockResolvedValueOnce({
        items: [
          {
            id: 'm2',
            role: 'assistant',
            content: 'JWT-based session tokens.',
            messageStatus: 'completed',
            createdAt: '2026-09-11T11:01:00Z',
          },
        ],
        nextCursor: null,
      });
    renderChat('/projects/prj_atlas/chat?conv=conv_1');
    expect(await screen.findByText('msgs boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/JWT-based session/i)).toBeTruthy();
  });
});
