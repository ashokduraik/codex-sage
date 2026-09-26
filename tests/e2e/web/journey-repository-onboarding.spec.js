import { expect, test } from '@playwright/test';

import { loginViaUi } from '../helpers/auth.js';
import { e2eEnv, skipLiveStack } from '../helpers/env.js';
import { expectKnowledgeFacets } from '../helpers/knowledge.js';
import { isKnowledgeBrowsable, openProcessingCenter, waitForTerminalHealth, waitForTerminalJobStatus } from '../helpers/processing.js';
import {
  cancelFollowUpAndCreateDialogs,
  createProjectViaUi,
  deleteProjectViaUi,
  generateE2eProjectName,
  navigateViaSidebar,
  openProjectFromList,
  openProjectTab,
} from '../helpers/projects.js';
import {
  attachPublicRepoViaUi,
  connectRepoDialog,
  createProjectWithPrivateRepo,
  expectConnectRepoError,
  expectConnectUrlStep,
  submitInvalidRepoUrl,
} from '../helpers/sources.js';

/**
 * Opens Sources → Add source so the connect dialog is available on an existing repo project.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {string} projectName Project to open.
 */
async function openConnectFromSources(page, projectName) {
  await openProjectFromList(page, projectName);
  await openProjectTab(page, 'Sources');
  await page.getByRole('button', { name: 'Add source' }).click();
  await expect(connectRepoDialog(page)).toBeVisible();
}

test.describe('Journey: repository onboarding via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  let publicProjectName;
  let privateProjectName;
  let publicHealth;

  test.beforeEach(async ({ page }) => {
    await loginViaUi(page);
    await navigateViaSidebar(page, 'Projects');
    await expect(page).toHaveURL('/projects');
  });

  test('create stays on the URL step when the repository URL is empty', async ({ page }) => {
    publicProjectName = generateE2eProjectName();
    await createProjectViaUi(page, publicProjectName, 'repo');
    const connect = connectRepoDialog(page).getByRole('button', { name: 'Connect repository' });
    await expect(connect).toBeDisabled();
    await expectConnectUrlStep(page);
    await cancelFollowUpAndCreateDialogs(page);
    await expect(page.getByRole('heading', { name: publicProjectName, level: 3 })).toBeVisible();
  });

  test('attach rejects an unreachable repository URL', async ({ page }) => {
    await openConnectFromSources(page, publicProjectName);
    await submitInvalidRepoUrl(page);
    await expectConnectRepoError(page, /Could not reach the repository|Repository not found|could not be verified/i);
    await expectConnectUrlStep(page);
    await connectRepoDialog(page).getByRole('button', { name: 'Cancel' }).click();
  });

  test('attach public repo succeeds', async ({ page }) => {
    await openConnectFromSources(page, publicProjectName);
    await attachPublicRepoViaUi(page);
    await openProjectTab(page, 'Sources');
    await expect(page.getByText(/octocat\/Hello-World|github.com/i).first()).toBeVisible();
  });

  test('processing and health reach a terminal state', async ({ page }) => {
    test.setTimeout(360_000);
    await openProjectFromList(page, publicProjectName);
    const projectId = page.url().split('/projects/')[1]?.split('/')[0];
    await openProcessingCenter(page, projectId);
    await waitForTerminalJobStatus(page);
    await page.goto(`/projects/${projectId}`);
    publicHealth = await waitForTerminalHealth(page);
    expect(['Ready', 'Partially available', 'Failed']).toContain(publicHealth);
    if (publicHealth === 'Failed') {
      await openProcessingCenter(page, projectId);
      await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
    }
  });

  test('knowledge browse runs when health is ready or partial', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(publicHealth), `Public-repo health is ${publicHealth ?? 'unknown'}`);
    await openProjectFromList(page, publicProjectName);
    await expectKnowledgeFacets(page);
  });

  test('attach private repo succeeds when credentials are set', async ({ page }) => {
    test.skip(!e2eEnv.hasPrivateRepo, 'E2E_PRIVATE_REPO_URL / E2E_GITHUB_TOKEN not set');
    privateProjectName = generateE2eProjectName();
    await createProjectWithPrivateRepo(page, privateProjectName);
    await openProjectFromList(page, privateProjectName);
    await openProjectTab(page, 'Sources');
    await expect(page.getByText('Connected').first()).toBeVisible();
  });

  test('deletes created projects', async ({ page }) => {
    await deleteProjectViaUi(page, publicProjectName);
    if (privateProjectName) {
      await deleteProjectViaUi(page, privateProjectName);
    }
  });
});
