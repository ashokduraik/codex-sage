/**
 * Unit tests for GitHub probe helpers (README extract + branch paging).
 */
import { describe, expect, it, vi } from 'vitest';
import { firstReadmeParagraph, listGithubBranches, readGithubDescription } from '../../../src/modules/knowledge/repositories.helper.js';

describe('firstReadmeParagraph', () => {
  it('returns the first non-heading paragraph', () => {
    expect(firstReadmeParagraph('# Title\n\nHello world.\n\nMore.')).toBe('Hello world.');
    expect(firstReadmeParagraph('# Only heading\n')).toBeNull();
    expect(firstReadmeParagraph('')).toBeNull();
  });
});

describe('listGithubBranches', () => {
  it('paginates, flags truncation, and keeps the default branch', async () => {
    const outboundGet = vi.fn().mockResolvedValue({
      status: 200,
      json: [{ name: 'b0' }, { name: 'b1' }, { name: 'b2' }],
    });
    const result = await listGithubBranches({
      ownerPath: 'acme',
      repoSlug: 'pay',
      defaultBranch: 'main',
      outboundGet,
      limit: 3,
    });
    expect(result.branches).toContain('main');
    expect(result.branchesTruncated).toBe(true);
    expect(result.branches.length).toBeLessThanOrEqual(3);
  });
});

describe('readGithubDescription', () => {
  it('returns null on any README failure instead of throwing', async () => {
    const outboundGet = vi.fn().mockRejectedValue(new Error('network'));
    await expect(
      readGithubDescription({
        ownerPath: 'acme',
        repoSlug: 'pay',
        outboundGet,
      }),
    ).resolves.toBeNull();
  });

  it('prefers the provider description when present', async () => {
    await expect(
      readGithubDescription({
        ownerPath: 'acme',
        repoSlug: 'pay',
        providerDescription: 'From API',
        outboundGet: vi.fn(),
      }),
    ).resolves.toBe('From API');
  });
});
