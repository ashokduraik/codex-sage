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

/** How long History-only may last before we treat a prior ingest as already done. */
const HISTORY_ONLY_GRACE_MS = 15_000;

/**
 * Waits until the ingest job leaves In progress and appears under History.
 *
 * @param {import('@playwright/test').Page} page Processing page.
 */
export async function waitForTerminalJobStatus(page) {
  await expect(page.getByRole('heading', { name: 'Processing Center' })).toBeVisible();
  const deadline = Date.now() + E2E_INGEST_WAIT_TIMEOUT_MS;
  let sawActive = false;
  let historyOnlySince = 0;
  while (Date.now() < deadline) {
    const historyVisible = await page
      .getByRole('heading', { name: 'History' })
      .isVisible()
      .catch(() => false);
    // Only the section heading — do not match job-status "Pending" text on cards.
    const inProgressVisible = await page
      .getByRole('heading', { name: 'In progress' })
      .isVisible()
      .catch(() => false);
    if (inProgressVisible) {
      sawActive = true;
      historyOnlySince = 0;
    }
    if (historyVisible && !inProgressVisible) {
      if (sawActive) {
        return;
      }
      if (!historyOnlySince) {
        historyOnlySince = Date.now();
      }
      if (Date.now() - historyOnlySince >= HISTORY_ONLY_GRACE_MS) {
        return;
      }
    }
    // Empty center can race a just-scheduled repo_sync; reload to pick up the job list.
    if (!historyVisible && !inProgressVisible) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Processing Center' })).toBeVisible();
    }
    await new Promise((resolve) => {
      setTimeout(resolve, E2E_INGEST_POLL_INTERVAL_MS);
    });
  }
  const hint = sawActive
    ? 'Job stayed in progress — start the stack with `npm run dev` (API + worker + Vite).'
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
    await new Promise((resolve) => {
      setTimeout(resolve, E2E_INGEST_POLL_INTERVAL_MS);
    });
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
