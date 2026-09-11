import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import ProjectDetailPage from './ProjectDetailPage';
import SourcesPanel from './SourcesPanel';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('SourcesPanel', () => {
  it('renders repository source details for Atlas', () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="sources" element={<SourcesPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/sources' },
    );

    expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy();
    expect(screen.getByText('acme/atlas-commerce')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Re-test connection/i }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add source/i })).toBeTruthy();
  });

  it('shows verified status after re-test completes', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="sources" element={<SourcesPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/sources' },
    );

    fireEvent.click(screen.getByRole('button', { name: /Re-test connection/i }));
    expect(screen.getByText('Testing connection…')).toBeTruthy();

    await waitFor(
      () => {
        expect(screen.getByText('Connection verified.')).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it('opens replace-credentials and saves a new token', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="sources" element={<SourcesPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/sources' },
    );

    fireEvent.click(screen.getByRole('button', { name: /Replace credentials/i }));
    expect(
      await screen.findByRole('heading', { name: /Replace credentials/i }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Access token/i), {
      target: { value: 'ghp_replacement_token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save token/i }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Replace credentials/i })).toBeNull();
    });
  });

  it('revokes repository credentials after confirmation', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="sources" element={<SourcesPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/sources' },
    );

    fireEvent.click(screen.getByRole('button', { name: /Revoke \/ disconnect/i }));
    expect(
      await screen.findByText(/Revoke repository credentials/i),
    ).toBeTruthy();
    const confirmButtons = screen.getAllByRole('button', { name: /^Revoke$/i });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    await waitFor(() => {
      expect(
        screen.queryByText(/Revoke repository credentials/i),
      ).toBeNull();
    });
  });

  it('opens the connect-repository dialog from Add source', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="sources" element={<SourcesPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/sources' },
    );

    fireEvent.click(screen.getByRole('button', { name: /Add source/i }));
    expect(
      await screen.findByRole('heading', { name: 'Connect repository' }),
    ).toBeTruthy();
  });
});
