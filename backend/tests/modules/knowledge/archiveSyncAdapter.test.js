/**
 * Unit tests for GitHub/GitLab archive HEAD + download.
 */
import { describe, expect, it, vi } from 'vitest';
import { downloadRepositoryArchive, resolveRemoteHead, splitGithubFullName } from '../../../src/modules/knowledge/repoSync.js';

const TOKEN = 'ghp_sync_adapter_token_never_log';

describe('archiveSyncAdapter', () => {
  it('resolves a GitHub HEAD sha and does not log the token', async () => {
    const outboundGet = vi.fn().mockResolvedValue({
      status: 200,
      json: { sha: 'abc123', commit: { message: 'fix' } },
    });
    const head = await resolveRemoteHead({
      provider: 'github',
      baseUrl: null,
      fullName: 'acme/payments',
      branch: 'main',
      token: TOKEN,
      outboundGet,
    });
    expect(head).toEqual({ commitSha: 'abc123', commitMessage: 'fix' });
    expect(outboundGet.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('resolves a GitLab HEAD sha for self-hosted hosts', async () => {
    const outboundGet = vi.fn().mockResolvedValue({
      status: 200,
      json: { id: 'def456', message: 'feat' },
    });
    const head = await resolveRemoteHead({
      provider: 'gitlab',
      baseUrl: 'https://gitlab.example',
      fullName: 'group/nested/app',
      branch: 'develop',
      token: TOKEN,
      outboundGet,
    });
    expect(head.commitSha).toBe('def456');
    expect(outboundGet.mock.calls[0][0].url).toContain('https://gitlab.example/api/v4/projects/group%2Fnested%2Fapp/repository/commits/develop');
  });

  it('maps authenticated 401 to user_action_required', async () => {
    await expect(
      resolveRemoteHead({
        provider: 'github',
        baseUrl: null,
        fullName: 'acme/payments',
        branch: 'main',
        token: TOKEN,
        outboundGet: vi.fn().mockResolvedValue({ status: 401, json: null }),
      }),
    ).rejects.toMatchObject({
      failureClass: 'user_action_required',
      code: 'token_invalid',
      probeStatus: 'authentication_required',
    });
  });

  it('downloads GitHub and GitLab archives', async () => {
    const zip = Buffer.from('PK');
    const github = await downloadRepositoryArchive({
      provider: 'github',
      baseUrl: null,
      fullName: 'acme/payments',
      branch: 'main',
      commitSha: 'abc123',
      token: TOKEN,
      outboundDownload: vi.fn().mockResolvedValue({ status: 200, buffer: zip }),
    });
    expect(github.archiveBuffer).toEqual(zip);

    const gitlab = await downloadRepositoryArchive({
      provider: 'gitlab',
      baseUrl: null,
      fullName: 'acme/app',
      branch: 'main',
      commitSha: 'abc123',
      token: null,
      outboundDownload: vi.fn().mockResolvedValue({ status: 200, buffer: zip }),
    });
    expect(gitlab.archiveBuffer).toEqual(zip);
  });

  it('maps network throws and rejects malformed GitHub names', async () => {
    await expect(
      resolveRemoteHead({
        provider: 'github',
        baseUrl: null,
        fullName: 'acme/payments',
        branch: 'main',
        outboundGet: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'PROBE_NETWORK' })),
      }),
    ).rejects.toMatchObject({
      failureClass: 'temporary',
      code: 'network_unreachable',
      probeStatus: 'unreachable',
    });

    expect(() => splitGithubFullName('nonesuch')).toThrow();

    await expect(
      downloadRepositoryArchive({
        provider: 'github',
        baseUrl: null,
        fullName: 'acme/payments',
        branch: 'main',
        commitSha: 'abc',
        outboundDownload: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'PROBE_NETWORK' })),
      }),
    ).rejects.toMatchObject({ code: 'network_unreachable' });

    await expect(
      downloadRepositoryArchive({
        provider: 'gitlab',
        baseUrl: null,
        fullName: 'acme/app',
        branch: 'main',
        commitSha: 'abc',
        outboundDownload: vi.fn().mockResolvedValue({ status: 403, buffer: Buffer.alloc(0) }),
      }),
    ).rejects.toMatchObject({ probeStatus: 'authentication_required' });
  });
});
