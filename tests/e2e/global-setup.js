import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { validateE2eEnv } from './helpers/validate-e2e-env.js';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(e2eDir, '.env');

/**
 * Playwright global setup: load env, then verify the operator-started stack.
 */
export default async function globalSetup() {
  if (!existsSync(envPath)) {
    throw new Error('Missing tests/e2e/.env — copy tests/e2e/.env.example to tests/e2e/.env and adjust values.');
  }

  dotenv.config({ path: envPath });
  validateE2eEnv(process.env);

  if (process.env.E2E_SKIP === '1') {
    return;
  }

  const baseUrl = (process.env.E2E_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  const apiUrl = (process.env.E2E_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  await assertReachable(`${apiUrl}/health`, 'API not reachable — start the API (`npm run dev`).');
  await assertReachable(`${baseUrl}/login`, 'Web app not reachable — start the frontend (`npm run dev`).');
}

/**
 * Fails the run when a required URL is down.
 *
 * @param {string} url URL to probe.
 * @param {string} message Error shown when the request fails.
 */
async function assertReachable(url, message) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} (${detail})`);
  }
}
