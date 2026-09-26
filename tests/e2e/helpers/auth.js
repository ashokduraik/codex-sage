import { expect } from '@playwright/test';

import { e2eEnv } from './env.js';

/**
 * Signs in through the login page and waits for Home.
 *
 * @param {import('@playwright/test').Page} page Playwright page.
 * @param {{ email?: string, password?: string, expectHome?: boolean }} [options] Credentials.
 */
export async function loginViaUi(page, options = {}) {
  const email = options.email ?? e2eEnv.adminEmail;
  const password = options.password ?? e2eEnv.adminPassword;
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  if (options.expectHome === false) {
    return;
  }
  await expect(page.getByRole('heading', { name: 'Understand your software system.' })).toBeVisible();
}

/**
 * Submits invalid credentials and waits for the API error alert.
 *
 * @param {import('@playwright/test').Page} page Playwright page.
 * @param {{ email?: string, password?: string }} [credentials] Fields to submit.
 */
export async function loginExpectingError(page, credentials = {}) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(credentials.email ?? e2eEnv.adminEmail);
  await page.getByLabel('Password').fill(credentials.password ?? 'wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
}

/**
 * Opens the header account menu (avatar trigger).
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 */
export async function openAccountMenu(page) {
  await page
    .locator('header')
    .locator('button')
    .filter({ has: page.locator('div.rounded-full') })
    .click();
}

/**
 * Signs out through the header menu and waits for the login page.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 */
export async function signOutViaUi(page) {
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
}

/**
 * Completes the signed-in change-password form.
 *
 * @param {import('@playwright/test').Page} page Change-password page.
 * @param {{ currentPassword: string, newPassword: string }} input Passwords.
 */
export async function changePasswordViaUi(page, input) {
  await page.getByLabel('Current password').fill(input.currentPassword);
  await page.getByLabel('New Password').fill(input.newPassword);
  await page.getByLabel('Confirm Password').fill(input.newPassword);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page).toHaveURL(/\/login/);
}
