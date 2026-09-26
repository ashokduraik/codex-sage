import { expect, test } from '@playwright/test';

import { loginViaUi } from '../helpers/auth.js';
import { skipLiveStack } from '../helpers/env.js';
import {
  cancelFollowUpAndCreateDialogs,
  createProjectSubmitButton,
  createProjectViaUi,
  deleteProjectViaUi,
  fillCreateProjectForm,
  generateE2eProjectName,
  navigateViaSidebar,
  openNewProjectDialog,
  openProjectFromList,
  archiveProjectViaUi,
  projectCard,
  restoreProjectViaUi,
  searchProjectsFor,
} from '../helpers/projects.js';

test.describe('Journey: project lifecycle via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  let projectName;

  test.beforeEach(async ({ page }) => {
    await loginViaUi(page);
    await navigateViaSidebar(page, 'Projects');
    await expect(page).toHaveURL('/projects');
  });

  test('create stays disabled without a name or source type', async ({ page }) => {
    await openNewProjectDialog(page);
    await expect(createProjectSubmitButton(page)).toBeDisabled();
    await fillCreateProjectForm(page, { sourceType: 'upload' });
    await expect(createProjectSubmitButton(page)).toBeDisabled();
    await fillCreateProjectForm(page, { name: 'E2E-missing-source' });
    await page.locator('#pname').fill('');
    await expect(createProjectSubmitButton(page)).toBeDisabled();
  });

  test('project creation succeeds without uploading', async ({ page }) => {
    projectName = generateE2eProjectName();
    await createProjectViaUi(page, projectName, 'upload');
    await cancelFollowUpAndCreateDialogs(page);
    await expect(projectCard(page, projectName)).toBeVisible();
  });

  test('search finds the created project', async ({ page }) => {
    await searchProjectsFor(page, projectName);
  });

  test('archive, restore, and delete the project', async ({ page }) => {
    await openProjectFromList(page, projectName);
    await archiveProjectViaUi(page, projectName);
    await restoreProjectViaUi(page);
    await deleteProjectViaUi(page, projectName);
  });
});
