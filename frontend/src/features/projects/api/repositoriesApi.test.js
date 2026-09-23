/**
 * Repository probe/attach API mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.fn();

vi.mock('@/shared/api', () => ({
  apiRequest: (...args) => apiRequest(...args),
}));

import {
  attachProjectRepository,
  getProjectRepositoryConnection,
  probeProjectRepository,
  repositoryConnectionQueryKey,
} from './repositoriesApi.js';

describe('repositoriesApi', () => {
  afterEach(() => {
    apiRequest.mockReset();
  });

  it('posts probe without a token when none is supplied', async () => {
    apiRequest.mockResolvedValue({ probeStatus: 'connected' });
    await probeProjectRepository({
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/atlas',
    });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/repositories/probe', {
      method: 'POST',
      body: { repositoryUrl: 'https://github.com/acme/atlas' },
      signal: undefined,
    });
  });

  it('includes accessToken on probe when provided', async () => {
    apiRequest.mockResolvedValue({ probeStatus: 'connected' });
    await probeProjectRepository({
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/private',
      accessToken: 'tok',
    });
    expect(apiRequest.mock.calls[0][1].body).toEqual({
      repositoryUrl: 'https://github.com/acme/private',
      accessToken: 'tok',
    });
  });

  it('posts attach with selectedBranch and Idempotency-Key', async () => {
    apiRequest.mockResolvedValue({ connection: { id: 'c1' } });
    await attachProjectRepository({
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/atlas',
      selectedBranch: 'main',
      accessToken: 'tok',
      idempotencyKey: 'idem-1',
    });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/repositories', {
      method: 'POST',
      body: {
        repositoryUrl: 'https://github.com/acme/atlas',
        selectedBranch: 'main',
        accessToken: 'tok',
      },
      idempotencyKey: 'idem-1',
      signal: undefined,
    });
  });

  it('omits accessToken on attach when public', async () => {
    apiRequest.mockResolvedValue({ connection: { id: 'c1' } });
    await attachProjectRepository({
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/atlas',
      selectedBranch: 'develop',
      idempotencyKey: 'idem-2',
    });
    expect(apiRequest.mock.calls[0][1].body).toEqual({
      repositoryUrl: 'https://github.com/acme/atlas',
      selectedBranch: 'develop',
    });
  });

  it('gets the connection and exposes a cache key', async () => {
    apiRequest.mockResolvedValue({ connection: { id: 'c1' } });
    await getProjectRepositoryConnection('p1', { signal: undefined });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/repositories/connection', {
      signal: undefined,
    });
    expect(repositoryConnectionQueryKey('p1')).toEqual([
      'projects',
      'p1',
      'repositories',
      'connection',
    ]);
  });
});
