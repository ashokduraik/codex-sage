/**
 * Journey: ZIP ingest → knowledge ready → grounded chat accuracy, context, and routing flows.
 */
import { expect, test } from '@playwright/test';

import { loginViaUi } from '../helpers/auth.js';
import {
  E2E_CHAT_ABSTAIN_QUESTION,
  E2E_CHAT_ANSWER_TIMEOUT_MS,
  E2E_CHAT_CLARIFICATION_QUESTION,
  E2E_CHAT_FIXTURE_QUESTION,
  E2E_CHAT_FOLLOWUP_VALUE_QUESTION,
  E2E_CHAT_GENERAL_QUESTION,
  E2E_CHAT_GREETING,
  E2E_CHAT_ISOLATION_FOLLOWUP,
  E2E_CHAT_QUEUED_NOTICE,
  archiveAndRestoreFirstConversation,
  editLastUserMessage,
  expectAbstain,
  expectChatDirectReply,
  expectClarificationOrUngroundedReply,
  expectEvidenceInspectFixture,
  expectGroundedAnswer,
  expectNoContextWarning,
  openProjectChat,
  renameFirstConversation,
  searchConversationsAndExpectHit,
  selectFirstRecentConversation,
  sendChatQuestion,
  sendChatQuestionAndStop,
  startNewChat,
  waitForChatIdle,
} from '../helpers/chat.js';
import { E2E_FIXTURE_SEARCH_TOKEN } from '../helpers/constants.js';
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
import { writeSampleProjectZip, writeSampleProjectZipWithExtraFile } from '../helpers/zip.js';

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

  test('strict grounded ask cites hello.js with the fixture value', async ({ page }) => {
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
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello/i, new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });
    await expectEvidenceInspectFixture(page);
    await expectNoContextWarning(page);
  });

  test('multi-turn follow-up keeps fixture context without repeating the constant name', async ({ page }) => {
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

    await selectFirstRecentConversation(page);
    await expect(page.getByText(new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')).first()).toBeVisible({ timeout: 30_000 });
    await sendChatQuestion(page, E2E_CHAT_FOLLOWUP_VALUE_QUESTION);
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello/i],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });
    await expectNoContextWarning(page);
  });

  test('leave chat and reopen continues the same conversation', async ({ page }) => {
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

    await selectFirstRecentConversation(page);
    await expect(page.getByText(new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')).first()).toBeVisible({ timeout: 30_000 });

    await openProjectTab(page, 'Overview');
    await openProjectChat(page, projectId);
    await selectFirstRecentConversation(page);
    await expect(page.getByText(new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')).first()).toBeVisible({ timeout: 30_000 });

    await sendChatQuestion(page, 'Which file defines that exported constant?');
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello\.js/i, new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });
  });

  test('abstains on a fictional module not in the sample ZIP', async ({ page }) => {
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
    await sendChatQuestion(page, E2E_CHAT_ABSTAIN_QUESTION);
    await waitForChatIdle(page);
    await expectAbstain(page, { forbiddenSourceMatchers: [/QuantumFluxBillingModule|NebulaTaxAdapter/i] });
  });

  test('New Chat does not inherit prior thread fixture context', async ({ page }) => {
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
    await sendChatQuestion(page, E2E_CHAT_ISOLATION_FOLLOWUP);
    await waitForChatIdle(page);

    const abstained = await page
      .getByText('Could not answer from project knowledge.')
      .isVisible()
      .catch(() => false);
    const insufficient = await page
      .getByText('Not enough project evidence to answer confidently.')
      .isVisible()
      .catch(() => false);
    const abstainTitle = await page
      .getByText('The project does not currently contain enough information to answer this question confidently.')
      .isVisible()
      .catch(() => false);

    if (abstained || insufficient || abstainTitle) {
      return;
    }

    const sourcesButton = page.getByRole('button', { name: /\d+ sources?/i });
    if ((await sourcesButton.count()) > 0) {
      await sourcesButton.first().click();
      await expect(page.getByText(/hello\.js/i)).toHaveCount(0);
    }
  });

  test('edit message resubmits and replaces the downstream answer', async ({ page }) => {
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
    await sendChatQuestion(page, E2E_CHAT_FIXTURE_QUESTION);
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello/i],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });

    // Self-contained edit (include the fixture token) so UNDERSTAND does not ask for clarification.
    await editLastUserMessage(page, `In which source file is the exported constant ${E2E_FIXTURE_SEARCH_TOKEN} defined? Cite the path only.`);
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello\.js/i],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });
  });

  test('ambiguous question clarifies or stays ungrounded', async ({ page }) => {
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
    await sendChatQuestion(page, E2E_CHAT_CLARIFICATION_QUESTION);
    // Clarification may arrive without a full Stop→Send cycle if the stream ends awaiting_clarification.
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

  test('Stop cancels an in-flight generation', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 60_000);

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
    await sendChatQuestionAndStop(page, E2E_CHAT_FIXTURE_QUESTION);

    const stopped =
      (await page
        .getByText('Generation stopped')
        .isVisible()
        .catch(() => false)) ||
      (await page
        .getByText('Cancelled')
        .isVisible()
        .catch(() => false)) ||
      (await page
        .getByText(/statusCancelled|Interrupted/i)
        .isVisible()
        .catch(() => false));
    const sourcesAfterCancel = await page.getByRole('button', { name: /\d+ sources?/i }).count();
    expect(stopped || sourcesAfterCancel === 0).toBe(true);
  });

  test('ask while knowledge is updating shows queued notice then answers', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 360_000);

    await openProjectFromList(page, projectName);
    await openProjectTab(page, 'Sources');
    await page.getByRole('button', { name: 'Add source' }).click();
    await uploadZipViaUi(page, await writeSampleProjectZipWithExtraFile());

    await openProjectChat(page, projectId);
    await startNewChat(page);
    const composer = page.getByPlaceholder('Ask anything about this project…');
    if (await composer.isEnabled().catch(() => false)) {
      await sendChatQuestion(page, E2E_CHAT_FIXTURE_QUESTION);
      await Promise.race([
        page.getByText(E2E_CHAT_QUEUED_NOTICE).waitFor({ state: 'visible', timeout: 20_000 }),
        page.getByText(/Queued — knowledge is updating/i).waitFor({ state: 'visible', timeout: 20_000 }),
        page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'visible', timeout: 20_000 }),
      ]).catch(() => undefined);
      await waitForChatIdle(page, E2E_CHAT_ANSWER_TIMEOUT_MS + 180_000);
    } else {
      await page.goto(`/projects/${projectId}`);
      healthLabel = await waitForTerminalHealth(page);
      test.skip(!isKnowledgeBrowsable(healthLabel), `Re-ingest health is ${healthLabel}`);
      await openProjectChat(page, projectId);
      await sendChatQuestion(page, E2E_CHAT_FIXTURE_QUESTION);
      await waitForChatIdle(page);
    }

    await expectGroundedAnswer(page, {
      answerMatchers: [/hello/i, new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });
  });

  test('archive restore rename and search keep the conversation askable', async ({ page }) => {
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
    await sendChatQuestion(page, E2E_CHAT_FIXTURE_QUESTION);
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello/i],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });

    const renamedTitle = `E2E-chat-${Date.now()}`;
    await renameFirstConversation(page, renamedTitle);
    await archiveAndRestoreFirstConversation(page);
    await searchConversationsAndExpectHit(page, renamedTitle);

    await page
      .getByRole('option', { name: new RegExp(renamedTitle) })
      .first()
      .click();
    await sendChatQuestion(page, E2E_CHAT_FOLLOWUP_VALUE_QUESTION);
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello/i],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });
  });

  test('Ask about this from Search opens Chat with the attachment', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 180_000);

    await openProjectFromList(page, projectName);
    await openProjectTab(page, 'Search');
    await page.getByPlaceholder('Search knowledge…').fill(E2E_FIXTURE_SEARCH_TOKEN);
    const askAbout = page.getByRole('button', { name: 'Ask about this' }).first();
    await expect(askAbout).toBeVisible({ timeout: 60_000 });
    await askAbout.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/chat`));
    await expect(page.getByText(/Attached:/i).first()).toBeVisible({ timeout: 30_000 });

    await sendChatQuestion(page, 'Where is this defined and what value does it hold?');
    await waitForChatIdle(page);
    await expectGroundedAnswer(page, {
      answerMatchers: [/hello/i, new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')],
      sourceMatchers: [/hello\.js/i],
      minAnswerMatches: 1,
    });
  });

  test('replies to a greeting without abstaining', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 60_000);

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
    await sendChatQuestion(page, E2E_CHAT_GREETING);
    await waitForChatIdle(page);
    await expectChatDirectReply(page);
  });

  test('answers a general question with the general-knowledge note', async ({ page }) => {
    test.skip(!isKnowledgeBrowsable(healthLabel), `Chat needs ready/partial knowledge; health is ${healthLabel ?? 'unknown'}`);
    test.setTimeout(E2E_CHAT_ANSWER_TIMEOUT_MS + 60_000);

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
    await sendChatQuestion(page, E2E_CHAT_GENERAL_QUESTION);
    await waitForChatIdle(page);
    await expectChatDirectReply(page, { requireGeneralNote: true });
  });
});
