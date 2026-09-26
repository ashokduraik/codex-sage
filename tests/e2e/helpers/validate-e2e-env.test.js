import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasPrivateRepoEnv, isE2eSkip, validateE2eEnv } from './validate-e2e-env.js';

describe('validateE2eEnv', () => {
  it('does not require a .env file (Playwright config and global-setup enforce that)', () => {
    assert.doesNotThrow(() => validateE2eEnv({}));
  });

  it('treats E2E_SKIP=1 as a skip without throwing', () => {
    const env = { E2E_SKIP: '1' };
    assert.equal(isE2eSkip(env), true);
    assert.doesNotThrow(() => validateE2eEnv(env));
  });

  it('does not require private repo URL or token', () => {
    const env = {};
    assert.equal(hasPrivateRepoEnv(env), false);
    assert.doesNotThrow(() => validateE2eEnv(env));
  });

  it('reports private repo ready only when both URL and token are set', () => {
    assert.equal(hasPrivateRepoEnv({ E2E_PRIVATE_REPO_URL: 'https://github.com/org/private.git' }), false);
    assert.equal(hasPrivateRepoEnv({ E2E_GITHUB_TOKEN: 'token' }), false);
    assert.equal(
      hasPrivateRepoEnv({
        E2E_PRIVATE_REPO_URL: 'https://github.com/org/private.git',
        E2E_GITHUB_TOKEN: 'token',
      }),
      true,
    );
  });

  it('ignores blank private repo values', () => {
    assert.equal(
      hasPrivateRepoEnv({
        E2E_PRIVATE_REPO_URL: '   ',
        E2E_GITHUB_TOKEN: '   ',
      }),
      false,
    );
  });
});
