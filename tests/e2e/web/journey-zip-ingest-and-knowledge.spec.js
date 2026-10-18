import { expect, test } from '@playwright/test';

import { loginViaUi } from '../helpers/auth.js';
import { skipLiveStack } from '../helpers/env.js';
import { expectChangePaths, expectKnowledgeFacets, searchAndOpenPreview } from '../helpers/knowledge.js';
import {
  expectHealthFileCountMatchesActivityLog,
  isKnowledgeBrowsable,
  openProcessingCenter,
  waitForTerminalHealth,
  waitForTerminalJobStatus,
} from '../helpers/processing.js';
import {
  cleanupCreatedProjects,
  createProjectViaUi,
  generateE2eProjectName,
  navigateViaSidebar,
  openProjectFromList,
  openProjectTab,
  projectIdFromCard,
} from '../helpers/projects.js';
import { chooseUploadFile, expectFolderUnsupportedAlert, uploadSourceDialog, uploadZipViaUi } from '../helpers/sources.js';
import { writeNonZipUpload, writeSampleProjectZip, writeSampleProjectZipWithExtraFile } from '../helpers/zip.js';

test.describe('Journey: ZIP ingest and knowledge via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  let projectName;
  let healthLabel;

  test.beforeEach(async ({ page }) => {
    await loginViaUi(page);
    await navigateViaSidebar(page, 'Projects');
    await expect(page).toHaveURL('/projects');
  });

  test.afterAll(async ({ browser }) => {
    await cleanupCreatedProjects(browser, [projectName]);
  });

  test('rejects a non-ZIP file', async ({ page }) => {
    projectName = generateE2eProjectName();
    await createProjectViaUi(page, projectName, 'upload');
    await chooseUploadFile(page, await writeNonZipUpload());
    await expectFolderUnsupportedAlert(page);
  });

  test('uploads a sample ZIP', async ({ page }) => {
    await openProjectFromList(page, projectName);
    await openProjectTab(page, 'Sources');
    await page.getByRole('button', { name: 'Add source' }).click();
    await expect(uploadSourceDialog(page)).toBeVisible();
    await uploadZipViaUi(page, await writeSampleProjectZip());
    await expect(page.getByText('Upload').first()).toBeVisible();
  });

  test('processing and health reach a terminal state', async ({ page }) => {
    test.setTimeout(360_000);
    const projectId = await projectIdFromCard(page, projectName);
    await openProcessingCenter(page, projectId);
    await waitForTerminalJobStatus(page);
    await page.goto(`/projects/${projectId}`);
    healthLabel = await waitForTerminalHealth(page);
    expect(['Ready', 'Partially available', 'Failed']).toContain(healthLabel);
    if (healthLabel === 'Failed') {
      await openProcessingCenter(page, projectId);
      await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
    }
  });

  test('Health file count matches activity log Source validated count', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `ZIP ingest health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(180_000);
    const projectId = await projectIdFromCard(page, projectName);
    const fileCount = await expectHealthFileCountMatchesActivityLog(page, projectId);
    expect(fileCount).toBe(2);
  });

  test('knowledge and search work when health is ready or partial', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `ZIP ingest health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(180_000);
    await openProjectFromList(page, projectName);
    await expectKnowledgeFacets(page);
    await searchAndOpenPreview(page);
  });

  test('second ZIP shows change paths', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `ZIP ingest health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(360_000);
    await openProjectFromList(page, projectName);
    await openProjectTab(page, 'Sources');
    await page.getByRole('button', { name: 'Add source' }).click();
    await uploadZipViaUi(page, await writeSampleProjectZipWithExtraFile());
    const projectId = page.url().split('/projects/')[1]?.split('/')[0];
    await openProcessingCenter(page, projectId);
    await waitForTerminalJobStatus(page);
    await page.goto(`/projects/${projectId}`);
    const secondHealth = await waitForTerminalHealth(page);
    test.skip(!isKnowledgeBrowsable(secondHealth), `Second ingest health is ${secondHealth}`);
    await expectChangePaths(page);
  });
});
