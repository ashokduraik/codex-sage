/**
 * Project list, create, archive, and teardown helpers for live-stack Playwright journeys.
 */
import { expect } from '@playwright/test';

import { loginViaUi } from './auth.js';
import { e2eEnv } from './env.js';

/**
 * Builds a unique project name for one E2E run.
 *
 * @returns {string} Name like `E2E-1710000000000`.
 */
export function generateE2eProjectName() {
  return `E2E-${Date.now()}`;
}

/**
 * Navigates using a primary sidebar link.
 *
 * @param {import('@playwright/test').Page} page Playwright page.
 * @param {string} label Link text (`Home`, `Projects`, …).
 */
export async function navigateViaSidebar(page, label) {
  await page.getByRole('link', { name: label, exact: true }).click();
}

/**
 * Locates the project card link on `/projects`.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {string} projectName Visible project title.
 * @returns {import('@playwright/test').Locator} Card link.
 */
export function projectCard(page, projectName) {
  return page.locator('a[href^="/projects/"]').filter({ has: page.getByRole('heading', { name: projectName, level: 3 }) });
}

/**
 * Reads the project id from a list card href.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {string} projectName Visible project title.
 * @returns {Promise<string>} Project id.
 */
export async function projectIdFromCard(page, projectName) {
  await searchProjectsFor(page, projectName);
  const href = await projectCard(page, projectName).getAttribute('href');
  const projectId = href?.split('/').pop();
  if (!projectId) {
    throw new Error(`Could not read project id for ${projectName}`);
  }
  return projectId;
}

/**
 * Opens the create-project dialog on `/projects`.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 */
export async function openNewProjectDialog(page) {
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Create project' })).toBeVisible();
}

/**
 * Primary submit button in the create-project dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @returns {import('@playwright/test').Locator} Submit button.
 */
export function createProjectSubmitButton(page) {
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  return dialog.getByRole('button', { name: /Continue to (upload|connect)|Next/ });
}

/**
 * Chooses Upload source or Connect repository in the create dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {'upload' | 'repo'} sourceType Source path.
 */
export async function chooseCreateSourceType(page, sourceType) {
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  const label = sourceType === 'repo' ? 'Connect repository' : 'Upload source';
  await dialog.getByRole('button', { name: label }).click();
}

/**
 * Fills the create-project form without submitting.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {{ name?: string, sourceType?: 'upload' | 'repo' }} input Form values.
 */
export async function fillCreateProjectForm(page, input) {
  if (input.name !== undefined) {
    await page.locator('#pname').fill(input.name);
  }
  if (input.sourceType) {
    await chooseCreateSourceType(page, input.sourceType);
  }
}

/**
 * Creates a project and leaves the follow-up source dialog open.
 *
 * @param {import('@playwright/test').Page} page Authenticated page on `/projects`.
 * @param {string} projectName Unique name.
 * @param {'upload' | 'repo'} sourceType Source path.
 */
export async function createProjectViaUi(page, projectName, sourceType) {
  await openNewProjectDialog(page);
  await fillCreateProjectForm(page, { name: projectName, sourceType });
  const submitName = sourceType === 'repo' ? 'Continue to connect' : 'Continue to upload';
  await page.getByRole('dialog', { name: 'Create project' }).getByRole('button', { name: submitName }).click();
  const followUpTitle = sourceType === 'repo' ? 'Connect repository' : 'Upload source';
  await expect(page.getByRole('dialog', { name: followUpTitle })).toBeVisible();
}

/**
 * Cancels the stacked follow-up source dialog, then the create dialog behind it.
 * Radix keeps the create dialog mounted and aria-hidden until the follow-up unmounts,
 * so this waits for it to become interactive before clicking Cancel.
 *
 * @param {import('@playwright/test').Page} page Page with dialogs open.
 */
export async function cancelFollowUpAndCreateDialogs(page) {
  const followUp = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /Upload source|Connect repository/ }) });
  await expect(followUp).toBeVisible();
  await followUp.getByRole('button', { name: 'Cancel' }).click();
  await expect(followUp).toHaveCount(0);
  const createDialog = page.getByRole('dialog', { name: 'Create project' });
  await createDialog.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
  if (await createDialog.isVisible()) {
    await createDialog.getByRole('button', { name: 'Cancel' }).click();
  }
  await expect(createDialog).toHaveCount(0);
}

/**
 * Opens a project from the list.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {string} projectName Visible project title.
 */
export async function openProjectFromList(page, projectName) {
  await projectCard(page, projectName).click();
  await expect(page.getByRole('heading', { name: projectName, level: 1 })).toBeVisible();
}

const PROJECT_TAB_PATHS = Object.freeze({
  Overview: '',
  Knowledge: 'knowledge',
  Search: 'search',
  Changes: 'changes',
  Sources: 'sources',
  Health: 'health',
});

/**
 * Opens a project tab via the in-page nav so sidebar Knowledge/Search are not clicked.
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 * @param {keyof typeof PROJECT_TAB_PATHS} tabLabel Tab name.
 */
export async function openProjectTab(page, tabLabel) {
  const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1];
  if (!projectId) {
    throw new Error(`openProjectTab requires a project detail URL, got ${page.url()}`);
  }
  if (PROJECT_TAB_PATHS[tabLabel] === undefined) {
    throw new Error(`Unknown project tab: ${tabLabel}`);
  }
  // Click the project-shell tab nav only. Overview CTAs also link to Knowledge/Chat
  // with the same accessible name, which breaks Playwright strict mode under main.
  // Prefer SPA click over page.goto — a second full load can revoke a rotating session.
  const tabLink = page.getByRole('main').getByRole('navigation').getByRole('link', { name: tabLabel, exact: true });
  await expect(tabLink).toBeVisible();
  await tabLink.click();
  if (tabLabel !== 'Overview') {
    await expect(page.getByRole('heading', { name: tabLabel, level: 1 })).toBeVisible();
  }
}

/**
 * Opens the project actions menu (archive / delete).
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 */
export async function openProjectActions(page) {
  await page.getByRole('button', { name: 'Actions' }).click();
}

/**
 * Archives the open project from the detail actions menu.
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 * @param {string} projectName Project name used in the confirm title.
 */
export async function archiveProjectViaUi(page, projectName) {
  await openProjectActions(page);
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('heading', { name: `Archive ${projectName}?` })).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('This project is archived.')).toBeVisible();
}

/**
 * Restores the open archived project.
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 */
export async function restoreProjectViaUi(page) {
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('This project is archived.')).toHaveCount(0);
}

/**
 * Soft-deletes a project from its detail page.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {string} projectName Visible project title.
 */
export async function deleteProjectViaUi(page, projectName) {
  const onDetail = /\/projects\/[^/?#]+/.test(new URL(page.url()).pathname);
  if (!onDetail) {
    const listed = projectCard(page, projectName);
    if (!(await listed.isVisible().catch(() => false))) {
      await page.goto('/projects');
    }
    await openProjectFromList(page, projectName);
  }
  await openProjectActions(page);
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: `Delete ${projectName}?` })).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Delete project' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, projectName)).toHaveCount(0);
}

/**
 * Soft-deletes a leftover E2E project when it is still listed (active or archived).
 * No-ops when the name is blank or the card is already gone.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {string | undefined} projectName Name created during the journey.
 */
export async function deleteCreatedProjectIfPresent(page, projectName) {
  if (!projectName) {
    return;
  }
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('main').getByPlaceholder('Search projects…').fill(projectName);

  const card = projectCard(page, projectName);
  const foundActive = await card
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (!foundActive) {
    const activeToggle = page.getByRole('button', { name: 'Active', exact: true });
    if (!(await activeToggle.isVisible().catch(() => false))) {
      return;
    }
    await activeToggle.click();
    await expect(page.getByRole('button', { name: 'Archived', exact: true })).toBeVisible();
    const foundArchived = await card
      .waitFor({ state: 'visible', timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    if (!foundArchived) {
      return;
    }
  }
  await deleteProjectViaUi(page, projectName);
}

/**
 * Logs in on a fresh context and soft-deletes leftover E2E projects after a journey.
 * Runs even when an earlier serial test failed (Playwright still calls afterAll).
 *
 * @param {import('@playwright/test').Browser} browser Playwright browser.
 * @param {Array<string | undefined>} projectNames Names created during the suite.
 */
export async function cleanupCreatedProjects(browser, projectNames) {
  const names = [];
  for (const name of projectNames) {
    if (typeof name === 'string' && name.trim()) {
      names.push(name.trim());
    }
  }
  if (names.length === 0) {
    return;
  }
  const context = await browser.newContext({ baseURL: e2eEnv.baseUrl });
  const page = await context.newPage();
  try {
    await loginViaUi(page);
    for (const projectName of names) {
      await deleteCreatedProjectIfPresent(page, projectName);
    }
  } finally {
    await context.close();
  }
}

/**
 * Searches the projects list and waits for a named card.
 *
 * @param {import('@playwright/test').Page} page `/projects` page.
 * @param {string} projectName Name to search.
 */
export async function searchProjectsFor(page, projectName) {
  await page.getByRole('main').getByPlaceholder('Search projects…').fill(projectName);
  await expect(projectCard(page, projectName)).toBeVisible();
}
