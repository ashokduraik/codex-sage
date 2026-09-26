import { expect, test } from '@playwright/test';

import { loginExpectingError, loginViaUi, signOutViaUi } from '../helpers/auth.js';
import { skipLiveStack } from '../helpers/env.js';

test.describe('Journey: auth via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  test('invalid password shows an alert', async ({ page }) => {
    await loginExpectingError(page);
    await expect(page.getByRole('alert')).toContainText(/Invalid email or password/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('valid login reaches Home', async ({ page }) => {
    await loginViaUi(page);
    await expect(page.getByRole('heading', { name: 'Understand your software system.' })).toBeVisible();
  });

  test('sign out returns to login', async ({ page }) => {
    await loginViaUi(page);
    await signOutViaUi(page);
  });
});
