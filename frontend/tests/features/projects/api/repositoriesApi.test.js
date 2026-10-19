/**
 * Repository probe/attach API mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  syncProjectRepository,
  probeProjectRepository,
  attachProjectRepository,
  repositoryConnectionQueryKey,
  getProjectRepositoryConnection,
  retestProjectRepositoryConnection,
  revokeProjectRepositoryCredential,
  replaceProjectRepositoryCredential,
} from '@/features/projects/api/repositoriesApi.js';

const apiRequest = vi.fn();

vi.mock('@/shared/api/index', () => ({
  apiRequest: (...args) => apiRequest(...args),
}));

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
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/repositories/probe', {
      method: 'POST',
      body: { projectId: 'p1', repositoryUrl: 'https://github.com/acme/atlas' },
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
      projectId: 'p1',
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
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/repositories/attach', {
      method: 'POST',
      body: {
        projectId: 'p1',
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
      projectId: 'p1',
      repositoryUrl: 'https://github.com/acme/atlas',
      selectedBranch: 'develop',
    });
  });

  it('gets the connection and exposes a cache key', async () => {
    apiRequest.mockResolvedValue({ connection: { id: 'c1' } });
    await getProjectRepositoryConnection('p1', { signal: undefined });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/repositories/getConnection/p1', {
      signal: undefined,
    });
    expect(repositoryConnectionQueryKey('p1')).toEqual(['projects', 'p1', 'repositories', 'connection']);
  });

  it('replaces, revokes, and re-tests credentials on the shipped paths', async () => {
    apiRequest.mockResolvedValue({ connection: { id: 'c1' } });
    await replaceProjectRepositoryCredential({ projectId: 'p1', accessToken: 'tok' });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/repositories/replaceCredential', {
      method: 'POST',
      body: { projectId: 'p1', accessToken: 'tok' },
      signal: undefined,
    });
    apiRequest.mockResolvedValue(undefined);
    await revokeProjectRepositoryCredential({ projectId: 'p1' });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/repositories/revokeCredential', {
      method: 'POST',
      body: { projectId: 'p1' },
      signal: undefined,
    });
    apiRequest.mockResolvedValue({ connectionStatus: 'connected' });
    await retestProjectRepositoryConnection({ projectId: 'p1' });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/repositories/retestConnection', {
      method: 'POST',
      body: { projectId: 'p1' },
      signal: undefined,
    });
  });

  it('posts sync with an Idempotency-Key', async () => {
    apiRequest.mockResolvedValue({
      job: { id: 'j1', jobType: 'connected_repo_pull', jobStatus: 'pending', scheduledAt: '2026-01-02T00:00:00.000Z' },
    });
    await syncProjectRepository({ projectId: 'p1', idempotencyKey: 'idem-sync' });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/repositories/sync', {
      method: 'POST',
      body: { projectId: 'p1' },
      idempotencyKey: 'idem-sync',
      signal: undefined,
    });
  });
});
