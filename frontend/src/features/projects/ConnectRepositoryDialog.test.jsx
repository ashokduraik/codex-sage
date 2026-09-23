import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api';
import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

vi.mock('./api/repositoriesApi.js', () => ({
  probeProjectRepository: vi.fn(),
  attachProjectRepository: vi.fn(),
  getProjectRepositoryConnection: vi.fn(),
  repositoryConnectionQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'repositories', 'connection']),
}));

import {
  attachProjectRepository,
  probeProjectRepository,
} from './api/repositoriesApi.js';
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  probeProjectRepository.mockReset();
  attachProjectRepository.mockReset();
});

/**
 * @param {object} [overrides] Probe field overrides.
 * @returns {object}
 */
function connectedProbe(overrides = {}) {
  return {
    probeStatus: 'connected',
    provider: 'github',
    hostKind: 'github_dotcom',
    baseUrl: 'https://github.com',
    repository: { fullName: 'acme/atlas-commerce', visibility: 'public' },
    defaultBranch: 'main',
    branches: ['main', 'develop'],
    branchesTruncated: false,
    ...overrides,
  };
}

/**
 * @param {import('react').ReactElement} ui Tree.
 * @param {object} [options] Render options.
 */
function renderDialog(ui, options = {}) {
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  return {
    queryClient,
    ...renderWithProviders(ui, { ...options, queryClient }),
  };
}

describe('ConnectRepositoryDialog', () => {
  it('probes a public URL, shows Connecting, then attaches on confirm', async () => {
    let resolveProbe;
    probeProjectRepository.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    attachProjectRepository.mockResolvedValue({
      connection: { id: 'c1', selectedBranch: 'main' },
    });
    const onConnected = vi.fn();
    const onOpenChange = vi.fn();
    const { queryClient } = renderDialog(
      <ConnectRepositoryDialog
        open
        onOpenChange={onOpenChange}
        projectId="prj_atlas"
        onConnected={onConnected}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Connect repository' })).toBeTruthy();
    expect(screen.queryByLabelText(/provider/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/atlas-commerce' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText('Connecting…')).toBeTruthy();
    expect(screen.queryByText('connected')).toBeNull();
    resolveProbe(connectedProbe());
    expect(await screen.findByText('verified.', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('acme/atlas-commerce')).toBeTruthy();
    expect(screen.getByText(/first sync will start shortly/i)).toBeTruthy();
    const connectButtons = screen.getAllByRole('button', {
      name: 'Connect repository',
    });
    fireEvent.click(connectButtons[connectButtons.length - 1]);
    await waitFor(() => {
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(attachProjectRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_atlas',
        repositoryUrl: 'https://github.com/acme/atlas-commerce',
        selectedBranch: 'main',
      }),
    );
    expect(attachProjectRepository.mock.calls[0][0].accessToken).toBeUndefined();
    const variables = queryClient
      .getMutationCache()
      .getAll()
      .map((entry) => entry.state.variables);
    expect(JSON.stringify(variables)).not.toContain('ghp_');
  });

  it('shows mapped not-found and unreachable errors', async () => {
    probeProjectRepository.mockResolvedValue({
      probeStatus: 'not_found',
      reason: { code: 'repository_not_found' },
    });
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/missing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/could not be found/i)).toBeTruthy();

    cleanup();
    seedAuthSession();
    probeProjectRepository.mockResolvedValue({
      probeStatus: 'unreachable',
      reason: { code: 'network_unreachable' },
    });
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/down' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText(/could not be reached/i)).toBeTruthy();
  });

  it('prompts for a token and shows Verifying on re-probe', async () => {
    probeProjectRepository
      .mockResolvedValueOnce({
        probeStatus: 'authentication_required',
        provider: 'github',
        hostKind: 'github_dotcom',
        repository: { fullName: 'acme/private-payments' },
        reason: { code: 'token_missing' },
      })
      .mockReturnValueOnce(
        new Promise(() => {
          /* pending verifying */
        }),
      );
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/private-payments' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText(/acme\/private-payments looks private/i)).toBeTruthy();
    expect(screen.getByText(/Get a GitHub access token/i)).toBeTruthy();
    expect(screen.getByText(/scopes your administrator documents/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Enter an access token/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Access Token'), {
      target: { value: 'ghp_valid_token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Verifying…')).toBeTruthy();
    expect(screen.queryByText('authentication_required')).toBeNull();
  });

  it('shows access denied after a rejected token', async () => {
    probeProjectRepository
      .mockResolvedValueOnce({
        probeStatus: 'authentication_required',
        provider: 'github',
        hostKind: 'github_dotcom',
        repository: { fullName: 'acme/private-api' },
        reason: { code: 'token_missing' },
      })
      .mockResolvedValueOnce({
        probeStatus: 'access_denied',
        reason: { code: 'insufficient_scope' },
      });
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/private-api' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    await screen.findByText(/looks private/i);
    fireEvent.change(screen.getByLabelText('Access Token'), {
      target: { value: 'ab' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/does not have access/i)).toBeTruthy();
  });

  it('uses the self-hosted GitLab token page and returns via Back', async () => {
    probeProjectRepository.mockResolvedValue({
      probeStatus: 'authentication_required',
      provider: 'gitlab',
      hostKind: 'gitlab_self_hosted',
      baseUrl: 'https://gitlab.acme.io',
      repository: { fullName: 'team/private-service' },
      reason: { code: 'token_missing' },
    });
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://gitlab.acme.io/team/private-service' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    await screen.findByText(/Get a GitLab \(self-hosted\) access token/i);
    const link = screen.getByRole('link', { name: /Open token page/i });
    expect(link.getAttribute('href')).toBe(
      'https://gitlab.acme.io/-/user_settings/personal_access_tokens',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Repository URL')).toBeTruthy();
    expect(screen.queryByLabelText('Access Token')).toBeNull();
  });

  it('renders a truncation notice and attach failure alert', async () => {
    probeProjectRepository.mockResolvedValue(
      connectedProbe({
        branchesTruncated: true,
        branches: ['main'],
      }),
    );
    attachProjectRepository.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'CONFLICT',
        message: 'A repository is already connected.',
        correlationId: 'corr-attach',
      }),
    );
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/atlas-commerce' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText(/branch list is truncated/i)).toBeTruthy();
    const connectButtons = screen.getAllByRole('button', {
      name: 'Connect repository',
    });
    fireEvent.click(connectButtons[connectButtons.length - 1]);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('A repository is already connected.')).toBeTruthy();
    expect(screen.getByText('corr-attach')).toBeTruthy();
  });

  it('surfaces HTTP 403, 400, and 429 messages without invented copy', async () => {
    probeProjectRepository.mockRejectedValue(
      new ApiError({ status: 403, code: 'FORBIDDEN', message: 'Missing repos.connect' }),
    );
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/atlas' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText('Missing repos.connect')).toBeTruthy();

    cleanup();
    seedAuthSession();
    probeProjectRepository.mockRejectedValue(
      new ApiError({ status: 400, code: 'VALIDATION_ERROR', message: 'repositoryUrl is invalid.' }),
    );
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'not-a-url' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText('repositoryUrl is invalid.')).toBeTruthy();
    expect(screen.queryByText('Connecting…')).toBeNull();

    cleanup();
    seedAuthSession();
    probeProjectRepository.mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'Slow down' }),
    );
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/atlas' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText('Slow down')).toBeTruthy();
    expect(screen.queryByText(/rate-limit policy/i)).toBeNull();
  });

  it('maps unknown probeStatus to the fallback and probes via Enter', async () => {
    probeProjectRepository.mockResolvedValue({ probeStatus: 'mystery' });
    const onOpenChange = vi.fn();
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={onOpenChange} projectId="prj_atlas" />,
    );
    const urlInput = screen.getByLabelText('Repository URL');
    fireEvent.change(urlInput, {
      target: { value: 'https://gitlab.com/acme/public-service' },
    });
    fireEvent.keyDown(urlInput, { key: 'Enter' });
    expect(await screen.findByText(/could not be verified/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clears the token from the DOM after a successful attach', async () => {
    const secret = 'ghp_never_show_this_token';
    probeProjectRepository
      .mockResolvedValueOnce({
        probeStatus: 'authentication_required',
        provider: 'github',
        hostKind: 'github_dotcom',
        repository: { fullName: 'acme/private' },
        reason: { code: 'token_missing' },
      })
      .mockResolvedValueOnce(
        connectedProbe({
          repository: { fullName: 'acme/private' },
          tokenUsed: true,
        }),
      );
    attachProjectRepository.mockResolvedValue({
      connection: { id: 'c1', selectedBranch: 'main' },
    });
    const { queryClient } = renderDialog(
      <ConnectRepositoryDialog
        open
        onOpenChange={() => undefined}
        projectId="prj_atlas"
      />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    await screen.findByLabelText('Access Token');
    fireEvent.change(screen.getByLabelText('Access Token'), {
      target: { value: secret },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('verified.')).toBeTruthy();
    const connectButtons = screen.getAllByRole('button', {
      name: 'Connect repository',
    });
    fireEvent.click(connectButtons[connectButtons.length - 1]);
    await waitFor(() => {
      expect(attachProjectRepository).toHaveBeenCalled();
    });
    expect(document.body.textContent).not.toContain(secret);
    const variables = queryClient
      .getMutationCache()
      .getAll()
      .map((entry) => entry.state.variables);
    expect(JSON.stringify(variables)).not.toContain(secret);
  });

  it('cancels from confirm, keeps the Idempotency-Key on in-flight, and shows gitlab.com help', async () => {
    probeProjectRepository.mockResolvedValue(
      connectedProbe({
        provider: 'gitlab',
        hostKind: 'gitlab_dotcom',
        baseUrl: 'https://gitlab.com',
        repository: { fullName: 'acme/public-service' },
        defaultBranch: undefined,
        branches: ['main'],
      }),
    );
    attachProjectRepository
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          code: 'IDEMPOTENCY_IN_FLIGHT',
          message: 'still attaching',
        }),
      )
      .mockResolvedValueOnce({ connection: { id: 'c1', selectedBranch: 'main' } });
    const onOpenChange = vi.fn();
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={onOpenChange} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://gitlab.com/acme/public-service' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText('verified.')).toBeTruthy();
    const connectButtons = screen.getAllByRole('button', {
      name: 'Connect repository',
    });
    fireEvent.click(connectButtons[connectButtons.length - 1]);
    expect(await screen.findByText('still attaching')).toBeTruthy();
    const afterInFlight = screen.getAllByRole('button', { name: 'Connect repository' });
    fireEvent.click(afterInFlight[afterInFlight.length - 1]);
    await waitFor(() => expect(attachProjectRepository).toHaveBeenCalledTimes(2));
    expect(attachProjectRepository.mock.calls[0][0].idempotencyKey).toBe(
      attachProjectRepository.mock.calls[1][0].idempotencyKey,
    );
  });

  it('shows gitlab.com token help and handles a non-Error probe failure', async () => {
    probeProjectRepository
      .mockResolvedValueOnce({
        probeStatus: 'authentication_required',
        provider: 'gitlab',
        hostKind: 'gitlab_dotcom',
        baseUrl: 'https://gitlab.com',
        reason: { code: 'token_missing' },
      })
      .mockRejectedValueOnce('probe-down');
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://gitlab.com/acme/private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    expect(await screen.findByText('Get a GitLab access token')).toBeTruthy();
    expect(screen.queryByText('Get a GitLab (self-hosted) access token')).toBeNull();
    const link = screen.getByRole('link', { name: /Open token page/i });
    expect(link.getAttribute('href')).toBe(
      'https://gitlab.com/-/user_settings/personal_access_tokens',
    );
    fireEvent.change(screen.getByLabelText('Access Token'), {
      target: { value: 'glpat-x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('probe-down')).toBeTruthy();
  });

  it('cancels from the confirm step', async () => {
    probeProjectRepository.mockResolvedValue(connectedProbe());
    const onOpenChange = vi.fn();
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={onOpenChange} projectId="prj_atlas" />,
    );
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/atlas-commerce' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }));
    await screen.findByText('verified.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancels from the URL step and constrains width on 375px', () => {
    const onOpenChange = vi.fn();
    renderDialog(
      <ConnectRepositoryDialog open onOpenChange={onOpenChange} projectId="prj_atlas" />,
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.className).toContain('w-[calc(100vw-1.5rem)]');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
