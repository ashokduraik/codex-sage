import { expect } from '@playwright/test';

import { E2E_FIXTURE_SEARCH_TOKEN } from './constants.js';
import { openProjectTab } from './projects.js';

/**
 * Asserts the knowledge explorer loaded backend facets (not the mock empty tree).
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 */
export async function expectKnowledgeFacets(page) {
  await openProjectTab(page, 'Knowledge');
  await expect(page.getByRole('heading', { name: 'Knowledge' })).toBeVisible();
  await expect(page.getByText('No knowledge yet')).toHaveCount(0);
  const facet = page.getByRole('button', { name: /Summary|Documentation|Symbols|Workflows|APIs/ }).first();
  await expect(facet).toBeVisible();
}

/**
 * Searches project knowledge for the sample-ZIP token and opens a preview.
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 * @param {string} [query] Search text.
 */
export async function searchAndOpenPreview(page, query = E2E_FIXTURE_SEARCH_TOKEN) {
  await openProjectTab(page, 'Search');
  await page.getByPlaceholder('Search knowledge…').fill(query);
  const openButton = page.getByRole('button', { name: 'Open' }).first();
  await expect(openButton).toBeVisible({ timeout: 30_000 });
  await openButton.click();
  await expect(page.getByRole('heading', { name: /src\/hello\.js|docs\/guide\.md|Source preview/ })).toBeVisible();
}

/**
 * Asserts the Changes panel lists at least one path after a second ingest.
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 */
export async function expectChangePaths(page) {
  await openProjectTab(page, 'Changes');
  await expect(page.getByRole('heading', { name: 'Changes' })).toBeVisible();
  await expect(page.getByText('No recent changes')).toHaveCount(0);
  await expect(page.locator('.font-mono').first()).toBeVisible();
}
