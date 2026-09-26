import { expect } from '@playwright/test';

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
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
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
 * Cancels an open follow-up source dialog, then the create dialog if it remains.
 *
 * @param {import('@playwright/test').Page} page Page with dialogs open.
 */
export async function cancelFollowUpAndCreateDialogs(page) {
  const followUp = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /Upload source|Connect repository/ }) });
  if (await followUp.isVisible().catch(() => false)) {
    await followUp.getByRole('button', { name: 'Cancel' }).click();
  }
  const createDialog = page.getByRole('dialog', { name: 'Create project' });
  if (await createDialog.isVisible().catch(() => false)) {
    await createDialog.getByRole('button', { name: 'Cancel' }).click();
  }
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
 * Opens a project tab by URL so the sidebar Knowledge/Search links are not clicked.
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 * @param {keyof typeof PROJECT_TAB_PATHS} tabLabel Tab name.
 */
export async function openProjectTab(page, tabLabel) {
  const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1];
  if (!projectId) {
    throw new Error(`openProjectTab requires a project detail URL, got ${page.url()}`);
  }
  const suffix = PROJECT_TAB_PATHS[tabLabel];
  if (suffix === undefined) {
    throw new Error(`Unknown project tab: ${tabLabel}`);
  }
  const path = suffix ? `/projects/${projectId}/${suffix}` : `/projects/${projectId}`;
  await page.goto(path);
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
  if (!page.url().includes('/projects/')) {
    await page.goto('/projects');
    await openProjectFromList(page, projectName);
  }
  await openProjectActions(page);
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: `Delete ${projectName}?` })).toBeVisible();
  await page.getByRole('button', { name: 'Delete project' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, projectName)).toHaveCount(0);
}

/**
 * Searches the projects list and waits for a named card.
 *
 * @param {import('@playwright/test').Page} page `/projects` page.
 * @param {string} projectName Name to search.
 */
export async function searchProjectsFor(page, projectName) {
  await page.getByPlaceholder('Search projects…').fill(projectName);
  await expect(projectCard(page, projectName)).toBeVisible();
}
