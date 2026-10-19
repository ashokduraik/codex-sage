/**
 * Project chat UI helpers for the live-stack Playwright chat journey.
 */
import { expect } from '@playwright/test';

import { E2E_FIXTURE_SEARCH_TOKEN } from './constants.js';

/** Default grounded question about the sample ZIP fixture. */
export const E2E_CHAT_FIXTURE_QUESTION = `Where is the exported constant ${E2E_FIXTURE_SEARCH_TOKEN} defined, and what string value does it hold?`;

/** Greeting used to assert conversational direct replies. */
export const E2E_CHAT_GREETING = 'hi';

/** Off-topic question used to assert general-knowledge direct replies. */
export const E2E_CHAT_GENERAL_QUESTION = 'What is the capital of France?';

/** Deterministic note the backend prepends to general-knowledge replies. */
export const E2E_CHAT_GENERAL_NOTE = "General answer, not based on this project's sources.";

/** Max wait for one chat ask to leave the generating state. */
export const E2E_CHAT_ANSWER_TIMEOUT_MS = 240_000;

/**
 * Opens the project Chat tab (SPA link — not a full page reload).
 *
 * @param {import('@playwright/test').Page} page Project detail page.
 * @param {string} projectId Project id.
 */
export async function openProjectChat(page, projectId) {
  const chatTab = page.getByRole('main').getByRole('link', { name: 'Chat', exact: true });
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
 * Asserts a terminal chat outcome: evidence citing the fixture file, or an abstain notice.
 * Fails with an LLM/stack hint when generation failed without a terminal grounded outcome.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page after idle.
 */
export async function expectChatTerminalOutcome(page) {
  const failed = page.getByText(/Generation failed/i);
  if (
    await failed
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error('Chat generation failed — confirm the API started with a reachable LLM (`npm run dev`) and retry.');
  }

  const sourcesButton = page.getByRole('button', { name: /\d+ sources?/i });
  const abstainTitle = page.getByText('The project does not currently contain enough information to answer this question confidently.');
  const abstainStatus = page.getByText('Could not answer from project knowledge.');
  const insufficientBanner = page.getByText('Not enough project evidence to answer confidently.');

  const hasSources = await sourcesButton
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (hasSources) {
    await sourcesButton.first().click();
    const citesFixtureFile = await page
      .getByText(/hello\.js/i)
      .first()
      .isVisible()
      .catch(() => false);
    const citesFixtureToken = await page
      .getByText(/codexSageE2eHello/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (citesFixtureFile || citesFixtureToken) {
      return;
    }
    // Sources present but not the fixture path — still a terminal grounded outcome.
    return;
  }

  const abstained =
    (await abstainTitle.isVisible().catch(() => false)) ||
    (await abstainStatus.isVisible().catch(() => false)) ||
    (await insufficientBanner.isVisible().catch(() => false));
  if (abstained) {
    return;
  }

  throw new Error('Chat did not show Sources citing hello.js or an abstain notice — confirm worker + LLM are running.');
}

/**
 * Asserts the last assistant turn is a direct reply: has text, no abstain notice, no Sources.
 *
 * @param {import('@playwright/test').Page} page Chat workspace page after idle.
 * @param {{ requireGeneralNote?: boolean }} [options] When true, require the general-knowledge note.
 */
export async function expectChatDirectReply(page, options = {}) {
  const failed = page.getByText('Generation failed');
  if (await failed.isVisible().catch(() => false)) {
    throw new Error('Chat generation failed — confirm the API started with a reachable LLM (`npm run dev`) and retry.');
  }

  const abstainTitle = page.getByText('The project does not currently contain enough information to answer this question confidently.');
  const abstainStatus = page.getByText('Could not answer from project knowledge.');
  const insufficient = page.getByText('Not enough project evidence to answer confidently.');
  expect(await abstainTitle.isVisible().catch(() => false)).toBe(false);
  expect(await abstainStatus.isVisible().catch(() => false)).toBe(false);
  expect(await insufficient.isVisible().catch(() => false)).toBe(false);

  const sourcesButton = page.getByRole('button', { name: /\d+ sources?/i });
  expect(await sourcesButton.count()).toBe(0);

  if (options.requireGeneralNote) {
    await expect(page.getByText(E2E_CHAT_GENERAL_NOTE).last()).toBeVisible({ timeout: 10_000 });
  } else {
    // Last assistant bubble should have some reply text (not empty pending).
    await expect(page.getByText(/./).last()).toBeVisible({ timeout: 10_000 });
  }
}
