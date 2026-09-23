/**
 * Unit tests for probe orchestration (provider calls mocked).
 */
import { describe, expect, it, vi } from 'vitest';
import { probeRepository } from './repositoryProbe.service.js';

describe('probeRepository', () => {
  it('returns connected with branches for a public GitHub URL', async () => {
    const result = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
      deps: {
        lookupGithub: vi.fn().mockResolvedValue({
          status: 200,
          json: {
            default_branch: 'main',
            html_url: 'https://github.com/acme/payments',
            private: false,
            description: 'Payments',
          },
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
        listGithubBranches: vi.fn().mockResolvedValue({
          branches: ['main', 'develop'],
          branchesTruncated: false,
        }),
        readGithubDescription: vi.fn().mockResolvedValue('Payments'),
      },
    });
    expect(result.probeStatus).toBe('connected');
    expect(result.branches).toEqual(['main', 'develop']);
    expect(result.tokenUsed).toBe(false);
    expect(result.repository.visibility).toBe('public');
  });

  it('returns authentication_required with baseUrl for a private self-hosted GitLab URL', async () => {
    const result = await probeRepository({
      repositoryUrl: 'https://gitlab.example.com/group/payments',
      deps: {
        lookupGitlab: vi.fn().mockResolvedValue({
          status: 404,
          json: { message: '404 Project Not Found' },
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
      },
    });
    expect(result.probeStatus).toBe('authentication_required');
    expect(result.baseUrl).toBe('https://gitlab.example.com');
    expect(result.reason.code).toBe('token_missing');
    expect(result.repository.fullName).toBe('group/payments');
  });

  it('returns connected when a valid token unlocks the repository', async () => {
    const lookupGitlab = vi
      .fn()
      .mockResolvedValueOnce({
        status: 404,
        json: { message: '404' },
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          default_branch: 'main',
          web_url: 'https://gitlab.com/acme/payments',
          visibility: 'private',
          description: 'Pay',
        },
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    const result = await probeRepository({
      repositoryUrl: 'https://gitlab.com/acme/payments',
      accessToken: 'glpat-valid',
      deps: {
        lookupGitlab,
        listGitlabBranches: vi.fn().mockResolvedValue({
          branches: ['main'],
          branchesTruncated: false,
        }),
        readGitlabDescription: vi.fn().mockResolvedValue('Pay'),
      },
    });
    expect(result.probeStatus).toBe('connected');
    expect(result.tokenUsed).toBe(true);
  });

  it('maps an invalid token to token_invalid and an unscoped token to access_denied', async () => {
    const invalid = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
      accessToken: 'bad',
      deps: {
        lookupGithub: vi
          .fn()
          .mockResolvedValueOnce({
            status: 404,
            json: { message: 'Not Found' },
            headers: new Headers({ 'content-type': 'application/json' }),
          })
          .mockResolvedValueOnce({
            status: 401,
            json: { message: 'Bad credentials' },
            headers: new Headers({ 'content-type': 'application/json' }),
          }),
      },
    });
    expect(invalid.reason.code).toBe('token_invalid');

    const denied = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
      accessToken: 'no-scope',
      deps: {
        lookupGithub: vi
          .fn()
          .mockResolvedValueOnce({
            status: 404,
            json: {},
            headers: new Headers({ 'content-type': 'application/json' }),
          })
          .mockResolvedValueOnce({
            status: 403,
            json: {},
            headers: new Headers({ 'content-type': 'application/json' }),
          }),
      },
    });
    expect(denied.probeStatus).toBe('access_denied');
  });

  it('maps provider timeout to unreachable without provider text', async () => {
    const result = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
      deps: {
        lookupGithub: vi.fn().mockRejectedValue(
          Object.assign(new Error('timed out contacting api.github.com status 504'), {
            code: 'PROBE_TIMEOUT',
          }),
        ),
      },
    });
    expect(result.probeStatus).toBe('unreachable');
    expect(JSON.stringify(result)).not.toContain('api.github.com');
    expect(JSON.stringify(result)).not.toContain('504');
  });

  it('throws VALIDATION_ERROR for a malformed URL and makes no lookup', async () => {
    const lookupGithub = vi.fn();
    await expect(
      probeRepository({
        repositoryUrl: 'ftp://github.com/acme/payments',
        deps: { lookupGithub },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(lookupGithub).not.toHaveBeenCalled();
  });
});
