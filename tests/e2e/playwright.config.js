import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

import { E2E_EXPECT_TIMEOUT_MS, E2E_TEST_TIMEOUT_MS } from './helpers/constants.js';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(e2eDir, '.env');

if (!existsSync(envPath)) {
  throw new Error('Missing tests/e2e/.env — copy tests/e2e/.env.example to tests/e2e/.env and adjust values.');
}

dotenv.config({ path: envPath });

/**
 * Parses common truthy env strings (`1`, `true`, `yes`).
 *
 * @param {string | undefined} raw Raw environment value.
 * @returns {boolean} Whether the value is truthy.
 */
function isTruthy(raw) {
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const headless = isTruthy(process.env.E2E_HEADLESS);

export default defineConfig({
  testDir: './web',
  globalSetup: './global-setup.js',
  timeout: E2E_TEST_TIMEOUT_MS,
  expect: {
    timeout: E2E_EXPECT_TIMEOUT_MS,
  },
  // Journeys share the bootstrap admin and one Mongo org — parallel files race on list/search and sessions.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    headless,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
