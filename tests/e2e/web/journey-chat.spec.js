/**
 * Journey: ZIP ingest → knowledge ready → ask a grounded question in project Chat.
 */
import { expect, test } from '@playwright/test';

import { loginViaUi } from '../helpers/auth.js';
import {
  E2E_CHAT_FIXTURE_QUESTION,
  E2E_CHAT_ANSWER_TIMEOUT_MS,
  expectChatTerminalOutcome,
  openProjectChat,
  sendChatQuestion,
  waitForChatIdle,
} from '../helpers/chat.js';
import { skipLiveStack } from '../helpers/env.js';
import { isKnowledgeBrowsable, openProcessingCenter, waitForTerminalHealth, waitForTerminalJobStatus } from '../helpers/processing.js';
import {
  cleanupCreatedProjects,
  createProjectViaUi,
  generateE2eProjectName,
  navigateViaSidebar,
  openProjectFromList,
  openProjectTab,
  projectIdFromCard,
} from '../helpers/projects.js';
import { uploadZipViaUi } from '../helpers/sources.js';
import { writeSampleProjectZip } from '../helpers/zip.js';

test.describe('Journey: Chat ask via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  let projectName;
  let projectId;
  let healthLabel;

  test.beforeEach(async ({ page }) => {
    await loginViaUi(page);
    await navigateViaSidebar(page, 'Projects');
    await expect(page).toHaveURL('/projects');
  });

  test.afterAll(async ({ browser }) => {
    await cleanupCreatedProjects(browser, [projectName]);
  });

  test('creates a project and uploads the sample ZIP', async ({ page }) => {
    projectName = generateE2eProjectName();
    await createProjectViaUi(page, projectName, 'upload');
    await uploadZipViaUi(page, await writeSampleProjectZip());
    await expect(page.getByText('Upload').first()).toBeVisible();
  });

  test('processing and health reach a terminal state', async ({ page }) => {
    test.setTimeout(360_000);
    projectId = await projectIdFromCard(page, projectName);
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

  test('asks a grounded question and reaches a terminal chat outcome', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 120_000);

    await openProjectFromList(page, projectName);
    await openProjectTab(page, 'Overview');
    await openProjectChat(page, projectId);

    const composer = page.getByPlaceholder('Ask anything about this project…');
    test.skip(
      !(await composer.isEnabled().catch(() => false)),
      'Chat composer disabled — project not askable (knowledge not ready) or LLM/stack issue',
    );

    await sendChatQuestion(page, E2E_CHAT_FIXTURE_QUESTION);
    await waitForChatIdle(page);
    await expectChatTerminalOutcome(page);
  });
});
