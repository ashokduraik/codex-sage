/**
 * Journey: git-sync prepayment-advisor → grounded EMI functional/technical chat + context flows.
 */
import { expect, test } from '@playwright/test';

import { loginViaUi } from '../helpers/auth.js';
import {
  E2E_CHAT_ANSWER_TIMEOUT_MS,
  countVisibleMatchers,
  expectClarificationOrUngroundedReply,
  expectGroundedAnswer,
  openProjectChat,
  selectFirstRecentConversation,
  sendChatQuestion,
  startNewChat,
  waitForChatIdle,
} from '../helpers/chat.js';
import {
  E2E_EMI_CLARIFICATION_QUESTION,
  E2E_EMI_FOLLOWUP_ANSWER_MATCHERS,
  E2E_EMI_FOLLOWUP_QUESTION,
  E2E_EMI_FUNCTIONAL_ANSWER_MATCHERS,
  E2E_EMI_FUNCTIONAL_MIN_MATCHES,
  E2E_EMI_FUNCTIONAL_QUESTION,
  E2E_EMI_FUNCTIONAL_SOURCE_MATCHERS,
  E2E_EMI_SOURCE_MATCHERS,
  E2E_EMI_TECHNICAL_FILE_MATCHERS,
  E2E_EMI_TECHNICAL_FUNCTION_MATCHERS,
  E2E_EMI_TECHNICAL_MIN_FUNCTION_MATCHES,
  E2E_EMI_TECHNICAL_QUESTION,
} from '../helpers/chat-repo-cases.js';
import { e2eEnv, skipLiveStack } from '../helpers/env.js';
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
import { attachPublicRepoViaUi } from '../helpers/sources.js';

test.describe('Journey: Chat via git-synced prepayment-advisor', () => {
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

  test('creates a project and attaches prepayment-advisor', async ({ page }) => {
    projectName = generateE2eProjectName();
    await createProjectViaUi(page, projectName, 'repo');
    await attachPublicRepoViaUi(page, e2eEnv.chatRepoUrl);
    // Create+attach leaves the browser on /projects; Sources tab needs project detail.
    await openProjectFromList(page, projectName);
    await openProjectTab(page, 'Sources');
    await expect(page.getByText(/prepayment-advisor|github.com/i).first()).toBeVisible();
  });

  test('processing and health reach a terminal state', async ({ page }) => {
    test.setTimeout(480_000);
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

  test('answers the functional EMI product-behavior question from repo knowledge', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 180_000);

    await openProjectFromList(page, projectName);
    await openProjectChat(page, projectId);
    test.skip(
      !(await page
        .getByPlaceholder('Ask anything about this project…')
        .isEnabled()
        .catch(() => false)),
      'Chat composer disabled',
    );

    await sendChatQuestion(page, E2E_EMI_FUNCTIONAL_QUESTION);
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: E2E_EMI_FUNCTIONAL_ANSWER_MATCHERS,
      sourceMatchers: E2E_EMI_FUNCTIONAL_SOURCE_MATCHERS,
      minAnswerMatches: E2E_EMI_FUNCTIONAL_MIN_MATCHES,
    });
  });

  test('answers the technical EMI implementation question from repo knowledge', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 180_000);

    await openProjectFromList(page, projectName);
    await openProjectChat(page, projectId);
    test.skip(
      !(await page
        .getByPlaceholder('Ask anything about this project…')
        .isEnabled()
        .catch(() => false)),
      'Chat composer disabled',
    );

    await startNewChat(page);
    await sendChatQuestion(page, E2E_EMI_TECHNICAL_QUESTION);
    await waitForChatIdle(page);

    await expectGroundedAnswer(page, {
      answerMatchers: E2E_EMI_TECHNICAL_FILE_MATCHERS,
      sourceMatchers: E2E_EMI_SOURCE_MATCHERS,
      minAnswerMatches: 1,
    });
    const functionHits = await countVisibleMatchers(page, E2E_EMI_TECHNICAL_FUNCTION_MATCHERS);
    expect(functionHits).toBeGreaterThanOrEqual(E2E_EMI_TECHNICAL_MIN_FUNCTION_MATCHES);
  });

  test('multi-turn follow-up retains EMI formula context without repeating EMI', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 180_000);

    await openProjectFromList(page, projectName);
    await openProjectChat(page, projectId);
    test.skip(
      !(await page
        .getByPlaceholder('Ask anything about this project…')
        .isEnabled()
        .catch(() => false)),
      'Chat composer disabled',
    );

    await selectFirstRecentConversation(page);
    await expect(page.getByText(/getEMIAmount|LoanUtils|loan\.utils\.ts|doCalc|emi-calculator/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await sendChatQuestion(page, E2E_EMI_FOLLOWUP_QUESTION);
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: E2E_EMI_FOLLOWUP_ANSWER_MATCHERS,
      sourceMatchers: E2E_EMI_SOURCE_MATCHERS,
      minAnswerMatches: 1,
    });
  });

  test('leave and reopen chat continues the EMI conversation', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 180_000);

    await openProjectFromList(page, projectName);
    await openProjectChat(page, projectId);
    test.skip(
      !(await page
        .getByPlaceholder('Ask anything about this project…')
        .isEnabled()
        .catch(() => false)),
      'Chat composer disabled',
    );

    await selectFirstRecentConversation(page);
    await expect(page.getByText(/getEMIAmount|LoanUtils|loan\.utils\.ts|doCalc|emi-calculator/i).first()).toBeVisible({
      timeout: 30_000,
    });

    await openProjectTab(page, 'Overview');
    await openProjectChat(page, projectId);
    await selectFirstRecentConversation(page);
    await expect(page.getByText(/getEMIAmount|LoanUtils|loan\.utils\.ts|doCalc|emi-calculator/i).first()).toBeVisible({
      timeout: 30_000,
    });

    await sendChatQuestion(page, 'Remind me which file that amount helper lives in.');
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: [/loan\.utils\.ts|LoanUtils|getEMIAmount|emi-calculator|doCalc/i],
      sourceMatchers: E2E_EMI_SOURCE_MATCHERS,
      minAnswerMatches: 1,
    });
  });

  test('ambiguous payments question clarifies or stays ungrounded', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 120_000);

    await openProjectFromList(page, projectName);
    await openProjectChat(page, projectId);
    test.skip(
      !(await page
        .getByPlaceholder('Ask anything about this project…')
        .isEnabled()
        .catch(() => false)),
      'Chat composer disabled',
    );

    await startNewChat(page);
    await sendChatQuestion(page, E2E_EMI_CLARIFICATION_QUESTION);
    await expect
      .poll(
        async () => {
          const stopVisible = await page
            .getByRole('button', { name: 'Stop' })
            .isVisible()
            .catch(() => false);
          const sendVisible = await page
            .getByRole('button', { name: 'Send' })
            .isVisible()
            .catch(() => false);
          const clarifyVisible =
            (await page
              .getByTestId('clarification-panel')
              .isVisible()
              .catch(() => false)) ||
            (await page
              .getByText(/Question \d+ of \d+/i)
              .isVisible()
              .catch(() => false)) ||
            (await page
              .getByText(/Waiting for clarification/i)
              .isVisible()
              .catch(() => false));
          return (!stopVisible && sendVisible) || clarifyVisible;
        },
        { timeout: E2E_CHAT_ANSWER_TIMEOUT_MS },
      )
      .toBe(true);
    await expectClarificationOrUngroundedReply(page);
  });
});
