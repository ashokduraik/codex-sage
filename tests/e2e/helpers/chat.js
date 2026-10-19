/**
 * Project chat UI helpers for live-stack Playwright chat journeys.
 */
import { expect } from '@playwright/test';

import { E2E_FIXTURE_SEARCH_TOKEN } from './constants.js';

/** Default grounded question about the sample ZIP fixture. */
export const E2E_CHAT_FIXTURE_QUESTION = `Where is the exported constant ${E2E_FIXTURE_SEARCH_TOKEN} defined, and what string value does it hold?`;

/**
 * Follow-up that omits the fixture constant name but names hello.js so retrieval stays reliable.
 * Pure pronouns ("What string value does it hold?") often abstain even with prior turns loaded.
 */
export const E2E_CHAT_FOLLOWUP_VALUE_QUESTION = 'What string value does the constant exported from hello.js hold?';

/** Vague follow-up used after New Chat to prove thread isolation. */
export const E2E_CHAT_ISOLATION_FOLLOWUP = 'What string value does that constant hold?';

/** Question about a fictional module — must abstain on the sample ZIP. */
export const E2E_CHAT_ABSTAIN_QUESTION = 'How does the QuantumFluxBillingModule reconcile ledger entries with the NebulaTaxAdapter?';

/** Ambiguous ZIP clarification trigger. */
export const E2E_CHAT_CLARIFICATION_QUESTION = 'What should I change in this project to improve it?';

/** Greeting used to assert conversational direct replies. */
export const E2E_CHAT_GREETING = 'hi';

/** Off-topic question used to assert general-knowledge direct replies. */
export const E2E_CHAT_GENERAL_QUESTION = 'What is the capital of France?';

/** Deterministic note the backend prepends to general-knowledge replies. */
export const E2E_CHAT_GENERAL_NOTE = "General answer, not based on this project's sources.";

/** Context-limit warning copy from en.json. */
export const E2E_CHAT_CONTEXT_WARNING = 'Approaching context limit. Consider starting a new chat for unrelated questions.';

/** Queued-while-updating notice from en.json. */
export const E2E_CHAT_QUEUED_NOTICE = 'Knowledge is updating — your question is queued and will be answered using the new map.';

/** Max wait for one chat ask to leave the generating state. */
export const E2E_CHAT_ANSWER_TIMEOUT_MS = 240_000;

/**
 * Opens the project Chat tab (SPA link — not a full page reload).
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 * @param {string} projectId Project id.
 */
export async function openProjectChat(page, projectId) {
  // Tab nav only — Overview also has an Open Chat CTA with the same accessible name.
  const chatTab = page.getByRole('main').getByRole('navigation').getByRole('link', { name: 'Chat', exact: true });
  if (await chatTab.isVisible().catch(() => false)) {
    await chatTab.click();
  } else {
    await page.goto(`/projects/${encodeURIComponent(projectId)}/chat`);
  }
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/chat`));
  await expect(page.getByPlaceholder('Ask anything about this project…')).toBeVisible({ timeout: 30_000 });
}

/**
 * Types a question and clicks Send.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @param {string} question Question text.
 */
export async function sendChatQuestion(page, question) {
  const composer = page.getByPlaceholder('Ask anything about this project…');
  await expect(composer).toBeEnabled();
  await composer.fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
}

/**
 * Waits until generation starts (Stop), then until the composer is idle again (Send).
 * Waiting for Send alone races — Send is still visible for a tick after click.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @param {number} [timeoutMs] Max wait for the full answer.
 */
export async function waitForChatIdle(page, timeoutMs = E2E_CHAT_ANSWER_TIMEOUT_MS) {
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: timeoutMs });
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
}

/**
 * Starts generation then clicks Stop before the answer completes.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @param {string} question Question text.
 */
export async function sendChatQuestionAndStop(page, question) {
  await sendChatQuestion(page, question);
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await stop.click();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
}

/**
 * Clicks New Chat in the conversation sidebar.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 */
export async function startNewChat(page) {
  await page.getByRole('button', { name: 'New Chat' }).click();
  await expect(page.getByPlaceholder('Ask anything about this project…')).toBeEnabled({ timeout: 30_000 });
}

/**
 * Selects the first conversation in the Recent history list and waits until it is active.
 * Without waiting for `?conv=` / aria-selected, Send can race and create a blank thread
 * (ChatWorkspace creates on send when no activeConvId), which breaks multi-turn follow-ups.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 */
export async function selectFirstRecentConversation(page) {
  const recentTab = page.getByRole('tab', { name: 'Recent' });
  if (await recentTab.isVisible().catch(() => false)) {
    await recentTab.click();
  }
  const option = page.getByRole('listbox', { name: 'Conversations' }).getByRole('option').first();
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(option).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  await expect(page).toHaveURL(/[?&]conv=/);
}

/**
 * Opens the conversation overflow menu for the active (first selected) recent item and runs an action.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @param {string|RegExp} actionName Menu item name (Rename, Archive, Restore, …).
 */
export async function runConversationMenuAction(page, actionName) {
  const list = page.getByRole('listbox', { name: 'Conversations' });
  const row = list.locator('.group').first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: actionName }).click();
}

/**
 * Renames the first recent conversation via the overflow menu.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @param {string} newTitle New title.
 */
export async function renameFirstConversation(page, newTitle) {
  await runConversationMenuAction(page, 'Rename');
  const input = page.getByRole('listbox', { name: 'Conversations' }).locator('input').first();
  await expect(input).toBeVisible();
  await input.fill(newTitle);
  await input.press('Enter');
  await expect(page.getByRole('option', { name: new RegExp(newTitle) }).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Archives the first recent conversation, switches to Archived, restores it, then back to Recent.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 */
export async function archiveAndRestoreFirstConversation(page) {
  await runConversationMenuAction(page, 'Archive');
  await page.getByRole('tab', { name: 'Archived' }).click();
  const archivedOption = page.getByRole('listbox', { name: 'Conversations' }).getByRole('option').first();
  await expect(archivedOption).toBeVisible({ timeout: 30_000 });
  await runConversationMenuAction(page, /Restore/i);
  await page.getByRole('tab', { name: 'Recent' }).click();
  await expect(page.getByRole('listbox', { name: 'Conversations' }).getByRole('option').first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Searches conversation history for a query and asserts at least one hit.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @param {string} query Search text.
 */
export async function searchConversationsAndExpectHit(page, query) {
  const search = page.getByPlaceholder('Search conversations');
  await expect(search).toBeVisible();
  await search.fill(query);
  await expect(page.getByRole('listbox', { name: 'Conversations' }).getByRole('option').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(query).first()).toBeVisible();
}

/**
 * Edits the last user message and resubmits.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @param {string} newContent Replacement question text.
 */
export async function editLastUserMessage(page, newContent) {
  const editButton = page.getByRole('button', { name: 'Edit' }).last();
  await editButton.click({ force: true });
  const editArea = page
    .locator('.group')
    .filter({ has: page.getByRole('button', { name: 'Submit edit' }) })
    .locator('textarea')
    .first();
  await expect(editArea).toBeVisible({ timeout: 10_000 });
  await editArea.fill(newContent);
  await page.getByRole('button', { name: 'Submit edit' }).click();
  await waitForChatIdle(page);
}

/**
 * Counts how many of the given matchers are visible on the page.
 *
 * @param {import('@playwright/test').Page} page Page.
 * @param {Array<string|RegExp>} matchers Text patterns.
 * @returns {Promise<number>} Visible match count.
 */
export async function countVisibleMatchers(page, matchers) {
  let visibleCount = 0;
  for (const matcher of matchers) {
    const pattern = matcher instanceof RegExp ? matcher : new RegExp(escapeRegExp(String(matcher)), 'i');
    const found = await page
      .getByText(pattern)
      .first()
      .isVisible()
      .catch(() => false);
    if (found) {
      visibleCount += 1;
    }
  }
  return visibleCount;
}

/**
 * Escapes a string for use inside a RegExp.
 *
 * @param {string} value Raw string.
 * @returns {string} Escaped pattern.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Throws when the last turn failed to generate.
 *
 * @param {import('@playwright/test').Page} page Chat page after idle.
 */
async function assertNoGenerationFailure(page) {
  const failed = page.getByText(/Generation failed/i);
  if (
    await failed
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error('Chat generation failed — confirm the API started with a reachable LLM (`npm run dev`) and retry.');
  }
}

/**
 * Returns whether an abstain / insufficient notice is visible.
 *
 * @param {import('@playwright/test').Page} page Chat page.
 * @returns {Promise<boolean>}
 */
async function isAbstainVisible(page) {
  const abstainTitle = page.getByText('The project does not currently contain enough information to answer this question confidently.');
  const abstainStatus = page.getByText('Could not answer from project knowledge.');
  const insufficientBanner = page.getByText('Not enough project evidence to answer confidently.');
  return (
    (await abstainTitle.isVisible().catch(() => false)) ||
    (await abstainStatus.isVisible().catch(() => false)) ||
    (await insufficientBanner.isVisible().catch(() => false))
  );
}

/**
 * Opens the Sources disclosure on the latest assistant turn when present.
 *
 * @param {import('@playwright/test').Page} page Chat page after idle.
 * @returns {Promise<boolean>} True when Sources were opened.
 */
export async function openSourcesIfPresent(page) {
  const sourcesButton = page.getByRole('button', { name: /\d+ sources?/i });
  const hasSources = await sourcesButton
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasSources) {
    return false;
  }
  await sourcesButton.first().click();
  return true;
}

/**
 * Asserts a strict grounded outcome: no abstain, Sources present, answer and source matchers pass.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page after idle.
 * @param {{
 *   answerMatchers?: Array<string|RegExp>,
 *   sourceMatchers?: Array<string|RegExp>,
 *   minAnswerMatches?: number,
 * }} [options] Matchers. When `minAnswerMatches` is set, at least that many answerMatchers must match.
 */
export async function expectGroundedAnswer(page, options = {}) {
  await assertNoGenerationFailure(page);

  if (await isAbstainVisible(page)) {
    throw new Error('Expected a grounded answer with Sources, but the assistant abstained.');
  }

  const opened = await openSourcesIfPresent(page);
  if (!opened) {
    throw new Error('Expected a Sources button on the grounded answer.');
  }

  const sourceMatchers = Array.isArray(options.sourceMatchers) ? options.sourceMatchers : [];
  for (const matcher of sourceMatchers) {
    const pattern = matcher instanceof RegExp ? matcher : new RegExp(escapeRegExp(String(matcher)), 'i');
    await expect(page.getByText(pattern).first()).toBeVisible({ timeout: 10_000 });
  }

  const answerMatchers = Array.isArray(options.answerMatchers) ? options.answerMatchers : [];
  if (answerMatchers.length === 0) {
    return;
  }

  const minAnswerMatches = typeof options.minAnswerMatches === 'number' ? options.minAnswerMatches : answerMatchers.length;
  const matched = await countVisibleMatchers(page, answerMatchers);
  if (matched < minAnswerMatches) {
    throw new Error(`Expected at least ${minAnswerMatches} answer anchors to match; found ${matched} of ${answerMatchers.length}.`);
  }
}

/**
 * Asserts abstain / insufficient UI without treating Sources as success.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page after idle.
 * @param {{ forbiddenSourceMatchers?: Array<string|RegExp> }} [options] Paths that must not appear as invented evidence.
 */
export async function expectAbstain(page, options = {}) {
  await assertNoGenerationFailure(page);

  if (!(await isAbstainVisible(page))) {
    throw new Error('Expected an abstain / insufficient notice.');
  }

  const forbidden = Array.isArray(options.forbiddenSourceMatchers) ? options.forbiddenSourceMatchers : [];
  if (forbidden.length === 0) {
    return;
  }

  const sourcesButton = page.getByRole('button', { name: /\d+ sources?/i });
  if ((await sourcesButton.count()) === 0) {
    return;
  }
  await sourcesButton.first().click();
  for (const matcher of forbidden) {
    const pattern = matcher instanceof RegExp ? matcher : new RegExp(escapeRegExp(String(matcher)), 'i');
    await expect(page.getByText(pattern)).toHaveCount(0);
  }
}

/**
 * Asserts the context-limit warning is not shown (short-thread false-positive guard).
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 */
export async function expectNoContextWarning(page) {
  await expect(page.getByText(E2E_CHAT_CONTEXT_WARNING)).toHaveCount(0);
}

/**
 * Returns whether the clarification wizard / awaiting chrome is visible.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page.
 * @returns {Promise<boolean>}
 */
export async function isClarificationUiVisible(page) {
  const panel = page.getByTestId('clarification-panel');
  const progress = page.getByText(/Question \d+ of \d+/i);
  const followUp = page.getByText('More detail is needed before answering.');
  const submit = page.getByRole('button', { name: 'Submit answers' });
  const awaiting = page.getByText(/Waiting for clarification/i);
  return (
    (await panel.isVisible().catch(() => false)) ||
    (await progress.isVisible().catch(() => false)) ||
    (await followUp.isVisible().catch(() => false)) ||
    (await submit.isVisible().catch(() => false)) ||
    (await awaiting.isVisible().catch(() => false))
  );
}

/**
 * Asserts the clarification wizard / panel is visible.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page after idle or mid-clarify.
 */
export async function expectClarificationUi(page) {
  if (!(await isClarificationUiVisible(page))) {
    throw new Error('Expected clarification UI after an ambiguous question — model answered without clarifying.');
  }
}

/**
 * Ambiguous asks may clarify, abstain, or answer without project Sources (general/ungrounded).
 * Fails only when the model invents project Sources for a personal/non-project question.
 *
 * @param {import('@playwright/test').Page} page Chat page after the ask settled.
 */
export async function expectClarificationOrUngroundedReply(page) {
  await assertNoGenerationFailure(page);
  if (await isClarificationUiVisible(page)) {
    return;
  }
  if (await isAbstainVisible(page)) {
    return;
  }
  if (
    await page
      .getByText(E2E_CHAT_GENERAL_NOTE)
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }
  const sourcesButton = page.getByRole('button', { name: /\d+ sources?/i });
  if ((await sourcesButton.count()) === 0) {
    return;
  }
  throw new Error('Expected clarification, abstain, general note, or an ungrounded reply — got a Sources-backed project answer.');
}

/**
 * Asserts evidence for the fixture file is inspectable, then dismisses preview if open.
 *
 * @param {import('@playwright/test').Page} page Chat page with Sources already opened (or will open).
 */
export async function expectEvidenceInspectFixture(page) {
  const opened = await openSourcesIfPresent(page);
  if (!opened) {
    throw new Error('Expected Sources before evidence inspect.');
  }
  await expect(page.getByText(/hello\.js/i).first()).toBeVisible();
  const pathButton = page.getByRole('button', { name: /hello\.js/i }).first();
  if (await pathButton.isVisible().catch(() => false)) {
    await pathButton.click();
  }
  const tokenVisible = await page
    .getByText(new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i'))
    .first()
    .isVisible()
    .catch(() => false);
  const helloVisible = await page
    .getByText(/hello\.js/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (!tokenVisible && !helloVisible) {
    throw new Error('Expected evidence preview or list to show hello.js / fixture token.');
  }
  await expect(page.getByPlaceholder('Ask anything about this project…')).toBeVisible();
}

/**
 * Asserts the last assistant turn is a direct reply: has text, no abstain notice, no Sources.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page after idle.
 * @param {{ requireGeneralNote?: boolean }} [options] When true, require the general-knowledge note.
 */
export async function expectChatDirectReply(page, options = {}) {
  await assertNoGenerationFailure(page);

  expect(await isAbstainVisible(page)).toBe(false);

  const sourcesButton = page.getByRole('button', { name: /\d+ sources?/i });
  expect(await sourcesButton.count()).toBe(0);

  if (options.requireGeneralNote) {
    await expect(page.getByText(E2E_CHAT_GENERAL_NOTE).last()).toBeVisible({ timeout: 10_000 });
  } else {
    await expect(page.getByText(/./).last()).toBeVisible({ timeout: 10_000 });
  }
}

/**
 * @deprecated Prefer {@link expectGroundedAnswer} for grounded asks. Kept for transitional imports.
 * @param {import('@playwright/test').Page} page Chat workspace page after idle.
 */
export async function expectChatTerminalOutcome(page) {
  await expectGroundedAnswer(page, {
    answerMatchers: [/hello/i, new RegExp(E2E_FIXTURE_SEARCH_TOKEN, 'i')],
    sourceMatchers: [/hello\.js/i],
    minAnswerMatches: 1,
  });
}
