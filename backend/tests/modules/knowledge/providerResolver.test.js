/**
 * Unit tests for repository URL inference.
 */
import { describe, expect, it } from 'vitest';
import { resolveRepositoryUrl } from '../../../src/modules/knowledge/repositories.helper.js';

describe('resolveRepositoryUrl', () => {
  it('maps github.com and strips .git plus trailing slashes', () => {
    const resolved = resolveRepositoryUrl('https://github.com/acme/payments.git/');
    expect(resolved).toMatchObject({
      provider: 'github',
      hostKind: 'github',
      baseUrl: null,
      ownerPath: 'acme',
      repoSlug: 'payments',
      fullName: 'acme/payments',
    });
  });

  it('maps gitlab.com and nested groups', () => {
    const resolved = resolveRepositoryUrl(
      'https://gitlab.com/group/subgroup/payments',
    );
    expect(resolved).toMatchObject({
      provider: 'gitlab',
      hostKind: 'gitlab_saas',
      baseUrl: null,
      fullName: 'group/subgroup/payments',
    });
  });

  it('treats an unknown host as self-hosted GitLab and returns baseUrl', () => {
    const resolved = resolveRepositoryUrl(
      'https://gitlab.example.com/group/subgroup/payments',
    );
    expect(resolved).toMatchObject({
      provider: 'gitlab',
      hostKind: 'gitlab_self_hosted',
      baseUrl: 'https://gitlab.example.com',
      fullName: 'group/subgroup/payments',
    });
  });

  it('normalizes SSH form', () => {
    const resolved = resolveRepositoryUrl('git@github.com:acme/payments.git');
    expect(resolved.provider).toBe('github');
    expect(resolved.fullName).toBe('acme/payments');
  });

  it('rejects non-HTTP schemes and embedded credentials', () => {
    expect(() => resolveRepositoryUrl('ftp://github.com/acme/payments')).toThrow(
      /supported repository URL/,
    );
    expect(() =>
      resolveRepositoryUrl('https://user:token@github.com/acme/payments'),
    ).toThrow(/must not include credentials/);
    expect(() => resolveRepositoryUrl('https://github.com/only-owner')).toThrow(
      /owner and repository/,
    );
    expect(() => resolveRepositoryUrl('')).toThrow(/required/);
  });
});
