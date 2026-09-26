import { expect } from '@playwright/test';

import { e2eEnv, INVALID_REPO_URL } from './env.js';
import { createProjectViaUi } from './projects.js';

/**
 * Connect-repository dialog locator.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog.
 * @returns {import('@playwright/test').Locator} Dialog.
 */
export function connectRepoDialog(page) {
  return page.getByRole('dialog', { name: 'Connect repository' });
}

/**
 * Upload-source dialog locator.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog.
 * @returns {import('@playwright/test').Locator} Dialog.
 */
export function uploadSourceDialog(page) {
  return page.getByRole('dialog', { name: 'Upload source' });
}

/**
 * Submits a repository URL on the connect dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {string} repositoryUrl URL to probe.
 */
export async function submitConnectRepoUrl(page, repositoryUrl) {
  const dialog = connectRepoDialog(page);
  await dialog.locator('#repo-url').fill(repositoryUrl);
  await dialog.getByRole('button', { name: 'Connect repository' }).click();
}

/**
 * Expects the connect dialog to stay on the URL step.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 */
export async function expectConnectUrlStep(page) {
  await expect(connectRepoDialog(page).locator('#repo-url')).toBeVisible();
}

/**
 * Expects the connect dialog token step.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 */
export async function expectConnectTokenStep(page) {
  await expect(connectRepoDialog(page).locator('#token')).toBeVisible();
}

/**
 * Submits a token on the connect dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {string} token Access token (whitespace reaches JS trim validation).
 */
export async function submitConnectToken(page, token) {
  const dialog = connectRepoDialog(page);
  await dialog.locator('#token').fill(token === '' ? ' ' : token);
  await dialog.getByRole('button', { name: 'Next' }).click();
}

/**
 * Confirms the probed repository (default branch is pre-selected).
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 */
export async function confirmConnectRepo(page) {
  const dialog = connectRepoDialog(page);
  await expect(dialog.getByText('verified.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect repository' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Attaches a public repository through the already-open connect dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {string} [repositoryUrl] Public clone URL.
 */
export async function attachPublicRepoViaUi(page, repositoryUrl = e2eEnv.publicRepoUrl) {
  await submitConnectRepoUrl(page, repositoryUrl);
  await confirmConnectRepo(page);
}

/**
 * Attaches a private repository through the already-open connect dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 */
export async function attachPrivateRepoViaUi(page) {
  await submitConnectRepoUrl(page, e2eEnv.privateRepoUrl);
  await expectConnectTokenStep(page);
  await submitConnectToken(page, e2eEnv.githubToken);
  await confirmConnectRepo(page);
}

/**
 * Creates a repository project and attaches a public repo.
 *
 * @param {import('@playwright/test').Page} page Authenticated `/projects` page.
 * @param {string} projectName Unique name.
 */
export async function createProjectWithPublicRepo(page, projectName) {
  await createProjectViaUi(page, projectName, 'repo');
  await attachPublicRepoViaUi(page);
}

/**
 * Creates a repository project and attaches the configured private repo.
 *
 * @param {import('@playwright/test').Page} page Authenticated `/projects` page.
 * @param {string} projectName Unique name.
 */
export async function createProjectWithPrivateRepo(page, projectName) {
  await createProjectViaUi(page, projectName, 'repo');
  await attachPrivateRepoViaUi(page);
}

/**
 * Asserts a probe error on the connect dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {RegExp} pattern Expected message.
 */
export async function expectConnectRepoError(page, pattern) {
  await expect(connectRepoDialog(page).getByRole('alert')).toContainText(pattern);
}

/**
 * Submits the invalid-host fixture URL.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 */
export async function submitInvalidRepoUrl(page) {
  await submitConnectRepoUrl(page, INVALID_REPO_URL);
}

/**
 * Chooses a ZIP (or other file) in the upload dialog.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {string} filePath Absolute path.
 */
export async function chooseUploadFile(page, filePath) {
  await uploadSourceDialog(page).locator('input[type="file"]').setInputFiles(filePath);
}

/**
 * Uploads a ZIP and waits for the dialog to close.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 * @param {string} filePath Absolute ZIP path.
 */
export async function uploadZipViaUi(page, filePath) {
  await chooseUploadFile(page, filePath);
  await uploadSourceDialog(page).getByRole('button', { name: 'Start processing' }).click();
  await expect(uploadSourceDialog(page)).toHaveCount(0);
}

/**
 * Asserts the upload dialog rejected a non-ZIP file.
 *
 * @param {import('@playwright/test').Page} page Page with the dialog open.
 */
export async function expectFolderUnsupportedAlert(page) {
  await expect(uploadSourceDialog(page).getByRole('alert')).toContainText('Folder upload is not supported yet');
}
