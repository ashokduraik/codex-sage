/**
 * Shared E2E environment defaults and resolved env bag for Playwright journeys.
 */
import { DEFAULT_CHAT_REPO_URL } from './chat-repo-cases.js';

/**
 * Stable public GitHub repo for attach-without-token.
 * Prefer a tiny repo with real source files — Hello-World is README-only and fails
 * SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS. Override via E2E_PUBLIC_REPO_URL.
 */
export const DEFAULT_PUBLIC_REPO_URL = 'https://github.com/sindresorhus/is-docker.git';

/**
 * Probe target for invalid-URL attach tests.
 * Uses an unreachable host so probe fails without a token (GitHub 404 without
 * auth is treated as private → token step, not an error alert).
 */
export const INVALID_REPO_URL = 'https://gitlab.invalid/codex-sage-e2e-does-not-exist/invalid-repo.git';

/** Bootstrap admin defaults — match `DEFAULT_ADMIN_*` in organizations.js. */
export const DEFAULT_ADMIN_EMAIL = 'admin@localhost';

/** Bootstrap admin password default — match `DEFAULT_ADMIN_PASSWORD`. */
export const DEFAULT_ADMIN_PASSWORD = 'abc123';

const privateRepoUrl = process.env.E2E_PRIVATE_REPO_URL?.trim() ?? '';
const githubToken = process.env.E2E_GITHUB_TOKEN?.trim() ?? '';

/** Shared E2E environment variables. */
export const e2eEnv = {
  baseUrl: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
  apiUrl: process.env.E2E_API_URL ?? 'http://localhost:3000',
  adminEmail: process.env.E2E_ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL,
  adminPassword: process.env.E2E_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD,
  publicRepoUrl: process.env.E2E_PUBLIC_REPO_URL?.trim() || DEFAULT_PUBLIC_REPO_URL,
  chatRepoUrl: process.env.E2E_CHAT_REPO_URL?.trim() || DEFAULT_CHAT_REPO_URL,
  privateRepoUrl,
  githubToken,
  repoBranch: process.env.E2E_REPO_BRANCH ?? 'main',
  hasPrivateRepo: Boolean(privateRepoUrl && githubToken),
};

/** When set, journey specs are skipped. */
export const skipLiveStack = process.env.E2E_SKIP === '1';
