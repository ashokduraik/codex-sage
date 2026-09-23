/**
 * Zod request schemas for repository routes — no secrets in validation details.
 */
import { describe, expect, it } from 'vitest';
import {
  attachBodySchema,
  mapRepositoryZodDetails,
  patchBranchBodySchema,
  probeBodySchema,
  replaceCredentialBodySchema,
} from './repositories.schemas.js';

describe('repositories.schemas', () => {
  it('accepts a probe body with or without a token', () => {
    expect(
      probeBodySchema.safeParse({ repositoryUrl: 'https://github.com/acme/app' }).success,
    ).toBe(true);
    expect(
      probeBodySchema.safeParse({
        repositoryUrl: 'https://github.com/acme/app',
        accessToken: 'tok',
      }).success,
    ).toBe(true);
    expect(probeBodySchema.safeParse({ repositoryUrl: '' }).success).toBe(false);
    expect(
      probeBodySchema.safeParse({
        repositoryUrl: 'https://github.com/acme/app',
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('requires selectedBranch on attach and rejects extra keys', () => {
    expect(
      attachBodySchema.safeParse({
        repositoryUrl: 'https://github.com/acme/app',
        selectedBranch: 'main',
      }).success,
    ).toBe(true);
    expect(
      attachBodySchema.safeParse({
        repositoryUrl: 'https://github.com/acme/app',
      }).success,
    ).toBe(false);
    expect(
      attachBodySchema.safeParse({
        repositoryUrl: 'https://github.com/acme/app',
        selectedBranch: 'main',
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('requires selectedBranch on patch and accessToken on replace', () => {
    expect(patchBranchBodySchema.safeParse({ selectedBranch: 'develop' }).success).toBe(
      true,
    );
    expect(patchBranchBodySchema.safeParse({}).success).toBe(false);
    expect(replaceCredentialBodySchema.safeParse({ accessToken: 'new' }).success).toBe(
      true,
    );
    expect(replaceCredentialBodySchema.safeParse({}).success).toBe(false);
  });

  it('redacts accessToken paths and falls back to body for root issues', () => {
    const details = mapRepositoryZodDetails({
      issues: [
        { path: ['accessToken'], message: 'too short' },
        { path: [], message: 'invalid payload' },
        { path: ['selectedBranch'], message: 'Required' },
      ],
    });
    expect(details).toEqual([
      { path: 'accessToken', message: 'invalid' },
      { path: 'body', message: 'invalid payload' },
      { path: 'selectedBranch', message: 'Required' },
    ]);
  });
});
