/**
 * Unit tests for GitLab probe helpers.
 */
import { describe, expect, it, vi } from 'vitest';
import { listGitlabBranches, looksLikeGitlabApi, readGitlabDescription } from './gitlabProbe.js';

describe('looksLikeGitlabApi', () => {
  it('accepts JSON and rejects HTML', () => {
    expect(
      looksLikeGitlabApi({
        status: 404,
        json: { message: '404' },
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    ).toBe(true);
    expect(
      looksLikeGitlabApi({
        status: 200,
        json: null,
        headers: new Headers({ 'content-type': 'text/html' }),
      }),
    ).toBe(false);
  });
});

describe('listGitlabBranches', () => {
  it('keeps the default branch when the list is truncated', async () => {
    const outboundGet = vi.fn().mockResolvedValue({
      status: 200,
      json: [{ name: 'a' }, { name: 'b' }],
    });
    const result = await listGitlabBranches({
      baseUrl: null,
      fullName: 'acme/pay',
      defaultBranch: 'main',
      outboundGet,
      limit: 2,
    });
    expect(result.branches[0]).toBe('main');
    expect(result.branchesTruncated).toBe(true);
  });
});

describe('readGitlabDescription', () => {
  it('returns null when README lookup fails', async () => {
    await expect(
      readGitlabDescription({
        baseUrl: 'https://gitlab.example.com',
        fullName: 'g/p',
        defaultBranch: 'main',
        outboundGet: vi.fn().mockRejectedValue(new Error('fail')),
      }),
    ).resolves.toBeNull();
  });
});
