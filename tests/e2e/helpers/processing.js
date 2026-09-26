import { expect } from '@playwright/test';

import { E2E_INGEST_POLL_INTERVAL_MS, E2E_INGEST_WAIT_TIMEOUT_MS } from './constants.js';
import { openProjectTab } from './projects.js';

/** Health labels that mean ingest finished (including failure). */
const TERMINAL_HEALTH_LABELS = ['Ready', 'Partially available', 'Failed'];

/** Health labels that allow knowledge/search assertions. */
const READY_HEALTH_LABELS = ['Ready', 'Partially available'];

/**
 * Opens the processing center for a project.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {string} projectId Project id.
 */
export async function openProcessingCenter(page, projectId) {
  await page.goto(`/processing?projectId=${encodeURIComponent(projectId)}`);
  await expect(page.getByRole('heading', { name: 'Processing Center' })).toBeVisible();
}

/**
 * Waits until the ingest job leaves In progress and appears under History.
 *
 * @param {import('@playwright/test').Page} page Processing page.
 */
export async function waitForTerminalJobStatus(page) {
  const deadline = Date.now() + E2E_INGEST_WAIT_TIMEOUT_MS;
  let sawPending = false;
  while (Date.now() < deadline) {
    const historyVisible = await page
      .getByRole('heading', { name: 'History' })
      .isVisible()
      .catch(() => false);
    const inProgressVisible = await page
      .getByRole('heading', { name: 'In progress' })
      .isVisible()
      .catch(() => false);
    if (
      await page
        .getByText('Pending', { exact: true })
        .isVisible()
        .catch(() => false)
    ) {
      sawPending = true;
    }
    if (historyVisible && !inProgressVisible) {
      return;
    }
    await page.waitForTimeout(E2E_INGEST_POLL_INTERVAL_MS);
  }
  const hint = sawPending
    ? 'Job stayed pending — start the stack with `npm run dev` (API + worker + Vite).'
    : 'Ingest did not reach a terminal job state in time.';
  throw new Error(hint);
}

/**
 * Opens Health and waits for a terminal knowledge-health label.
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 * @returns {Promise<string>} Visible health label.
 */
export async function waitForTerminalHealth(page) {
  await openProjectTab(page, 'Health');
  const deadline = Date.now() + E2E_INGEST_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const label of TERMINAL_HEALTH_LABELS) {
      const badge = page.getByText(label, { exact: true }).first();
      if (await badge.isVisible().catch(() => false)) {
        return label;
      }
    }
    await page.waitForTimeout(E2E_INGEST_POLL_INTERVAL_MS);
  }
  throw new Error('Project health did not reach ready / partial / failed — start the stack with `npm run dev` (API + worker + Vite).');
}

/**
 * Returns whether knowledge/search assertions should run.
 *
 * @param {string} healthLabel Terminal health label.
 * @returns {boolean} True for ready or partial.
 */
export function isKnowledgeBrowsable(healthLabel) {
  return READY_HEALTH_LABELS.includes(healthLabel);
}
