import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

import ChatWorkspace from '@/features/chat/ChatWorkspace';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
});
beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  Element.prototype.scrollTo = vi.fn();
});
describe('ChatWorkspace', () => {
  it('renders with route /projects/prj_atlas/chat and loads a conversation', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="chat" element={<ChatWorkspace />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/chat' },
    );
    expect(await screen.findByPlaceholderText('Ask anything about this project…')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByText('How does authentication work?').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/How does authentication work in this project/i)).toBeTruthy();
  });
  it('opens a specific conversation from the conv query param', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="chat" element={<ChatWorkspace />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/chat?conv=conv_2' },
    );
    expect((await screen.findAllByText('Where is payment implemented?')).length).toBeGreaterThan(0);
  });
  it('sends a grounded question from the composer', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="chat" element={<ChatWorkspace />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/chat?conv=conv_1' },
    );
    const input = await screen.findByPlaceholderText('Ask anything about this project…');
    fireEvent.change(input, {
      target: { value: 'How does authentication work again?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(
      () => {
        expect(screen.getAllByText(/JWT-based session/i).length).toBeGreaterThan(0);
      },
      { timeout: 8000 },
    );
  });
  it('shows a search attachment chip without auto-sending', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="chat" element={<ChatWorkspace />} />
        </Route>
      </Routes>,
      {
        route: '/projects/prj_atlas/chat',
        routeState: {
          searchAttachment: {
            id: 'kv1:symbol:refund',
            knowledgeVersionId: 'kv1',
            title: 'refundHandler',
          },
        },
      },
    );
    expect(await screen.findByText('Attached: refundHandler')).toBeTruthy();
    expect(screen.getByPlaceholderText('Ask anything about this project…').value).toBe('');
    expect(screen.queryByText('Searching project knowledge…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Attached: refundHandler')).toBeNull();
  });

  it('shows clarification chips for vague questions on a new chat', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="chat" element={<ChatWorkspace />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/chat' },
    );
    await screen.findByPlaceholderText('Ask anything about this project…');
    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
    const input = screen.getByPlaceholderText('Ask anything about this project…');
    fireEvent.change(input, { target: { value: 'tell me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Which area do you mean?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Which area do you mean?')).toBeNull();
  });
});
