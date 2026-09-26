/**
 * Returns whether live-stack journey specs should skip.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment map (defaults to `process.env`).
 * @returns {boolean} True when `E2E_SKIP=1`.
 */
export function isE2eSkip(env = process.env) {
  return env.E2E_SKIP === '1';
}

/**
 * Returns whether both private-repo attach variables are present.
 *
 * Private attach is optional: missing values do not fail the run.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment map (defaults to `process.env`).
 * @returns {boolean} True when URL and token are both non-empty.
 */
export function hasPrivateRepoEnv(env = process.env) {
  return Boolean(env.E2E_PRIVATE_REPO_URL?.trim() && env.E2E_GITHUB_TOKEN?.trim());
}

/**
 * Validates E2E env. Private repo vars are not required.
 * `E2E_SKIP=1` logs a skip line and returns.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment map (defaults to `process.env`).
 */
export function validateE2eEnv(env = process.env) {
  if (isE2eSkip(env)) {
    console.log('E2E skipped (E2E_SKIP=1)');
  }
}
