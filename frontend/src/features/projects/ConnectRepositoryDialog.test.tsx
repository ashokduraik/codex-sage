import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('ConnectRepositoryDialog', () => {
  it('probes a public GitHub URL and connects on confirm', async () => {
    const onConnected = vi.fn();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={onOpenChange}
        projectId="prj_atlas"
        onConnected={onConnected}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Connect repository' }),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/atlas-commerce' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));

    expect(
      await screen.findByText('verified.', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.getByText('acme/atlas-commerce')).toBeTruthy();

    const connectButtons = screen.getAllByRole('button', {
      name: 'Connect repository',
    });
    fireEvent.click(connectButtons[connectButtons.length - 1]!);

    await waitFor(
      () => {
        expect(onConnected).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenCalledWith(false);
      },
      { timeout: 3000 },
    );
  });

  it('shows not-found error for missing repositories', async () => {
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={() => undefined}
        projectId="prj_atlas"
      />,
    );

    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/does-not-exist' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));

    expect(
      await screen.findByRole('alert'),
    ).toBeTruthy();
    expect(screen.getByText(/Repository not found/i)).toBeTruthy();
  });

  it('shows unreachable error for unreachable hosts', async () => {
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={() => undefined}
        projectId="prj_atlas"
      />,
    );

    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://localhost:9999/org/repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));

    expect(await screen.findByText(/Could not reach the repository/i)).toBeTruthy();
  });

  it('prompts for a token on private repos and continues after a valid token', async () => {
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={() => undefined}
        projectId="prj_atlas"
      />,
    );

    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/private-payments' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));

    expect(
      await screen.findByText(/private or requires authentication/i),
    ).toBeTruthy();
    expect(screen.getByText(/Get a GitHub access token/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Enter an access token/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Access Token'), {
      target: { value: 'ghp_valid_token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText(/verified/i)).toBeTruthy();
  });

  it('rejects short tokens for private repositories', async () => {
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={() => undefined}
        projectId="prj_atlas"
      />,
    );

    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/private-api' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    await screen.findByText(/private or requires authentication/i);

    fireEvent.change(screen.getByLabelText('Access Token'), {
      target: { value: 'ab' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText(/Access denied/i)).toBeTruthy();
  });

  it('returns to the URL step from token help via Back', async () => {
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={() => undefined}
        projectId="prj_atlas"
      />,
    );

    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://gitlab.acme.io/team/private-service' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    await screen.findByText(/private or requires authentication/i);
    expect(
      screen.getByText(/Get a GitLab \(self-hosted\) access token/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Repository URL')).toBeTruthy();
  });

  it('cancels from the URL step', () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={onOpenChange}
        projectId="prj_atlas"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('probes a public GitLab URL via Enter and cancels from confirm', async () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ConnectRepositoryDialog
        open
        onOpenChange={onOpenChange}
        projectId="prj_atlas"
      />,
    );

    const urlInput = screen.getByLabelText('Repository URL');
    fireEvent.change(urlInput, {
      target: { value: 'https://gitlab.com/acme/public-service' },
    });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    expect(await screen.findByText(/verified/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
