import { expect } from '@playwright/test';

import { e2eEnv } from './env.js';

/**
 * Builds a unique invited-user email (must be a real TLD — `.localhost` fails zod email).
 *
 * @returns {{ displayName: string, email: string, password: string, nextPassword: string }}
 */
export function generateE2eUser() {
  const stamp = Date.now();
  return {
    displayName: `E2E User ${stamp}`,
    email: `e2e-${stamp}@example.com`,
    password: 'E2E-pass-1',
    nextPassword: 'E2E-pass-2',
  };
}

/**
 * Opens an admin section from the admin nav.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {'Users' | 'Roles & Permissions' | 'Audit'} section Nav label.
 */
export async function openAdminSection(page, section) {
  if (!page.url().includes('/admin')) {
    await page.goto('/admin/users');
  }
  await page.getByRole('link', { name: section, exact: true }).click();
}

/**
 * Creates an invited user assigned the Member role.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {{ displayName: string, email: string }} user Identity.
 */
export async function createInvitedUserViaUi(page, user) {
  await openAdminSection(page, 'Users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create user' });
  await expect(dialog).toBeVisible();
  await dialog.locator('#admin-create-name').fill(user.displayName);
  await dialog.locator('#admin-create-email').fill(user.email);
  const member = dialog.getByLabel('Member');
  if (!(await member.isChecked())) {
    await member.check();
  }
  const orgAdmin = dialog.getByLabel('Org Admin');
  if (await orgAdmin.isChecked()) {
    await orgAdmin.uncheck();
  }
  await dialog.getByRole('button', { name: 'Invite user' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Search users').fill(user.email);
  await expect(page.getByText(user.email)).toBeVisible();
}

/**
 * Opens the row actions menu for a user email.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {string} email User email.
 */
export async function openUserRowActions(page, email) {
  await expect(page.getByText(email)).toBeVisible();
  await page.getByLabel('Actions').click();
}

/**
 * Sets an admin-mediated password for a user.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {{ displayName: string, email: string, password: string }} user Target and password.
 */
export async function setUserPasswordViaUi(page, user) {
  await page.getByLabel('Search users').fill(user.email);
  await expect(page.getByText(user.email)).toBeVisible();
  await openUserRowActions(page, user.email);
  await page.getByRole('button', { name: 'Reset password' }).click();
  const dialog = page.getByRole('dialog', { name: `Set password for ${user.displayName}` });
  await dialog.locator('#admin-new-password').fill(user.password);
  await dialog.locator('#admin-confirm-password').fill(user.password);
  await dialog.getByRole('button', { name: 'Set password' }).click();
  await expect(dialog.getByRole('status')).toContainText('Password set completed');
  await dialog.getByRole('button', { name: 'Close' }).click();
}

/**
 * Toggles activate / deactivate for a user.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {string} email User email.
 * @param {'Deactivate' | 'Activate'} action Menu label.
 */
export async function toggleUserStatusViaUi(page, email, action) {
  await openUserRowActions(page, email);
  await page.getByRole('button', { name: action }).click();
}

/**
 * Assigns an extra built-in role (Viewer) to a user.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {{ displayName: string, email: string }} user Target.
 */
export async function addViewerRoleViaUi(page, user) {
  await openUserRowActions(page, user.email);
  await page.getByRole('button', { name: 'Edit roles' }).click();
  const dialog = page.getByRole('dialog', { name: `Edit roles for ${user.displayName}` });
  const viewer = dialog.getByLabel('Viewer');
  if (!(await viewer.isChecked())) {
    await viewer.check();
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Soft-removes a user.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {{ displayName: string, email: string }} user Target.
 */
export async function removeUserViaUi(page, user) {
  await page.getByLabel('Search users').fill(user.email);
  await openUserRowActions(page, user.email);
  await page.getByRole('button', { name: 'Remove user' }).click();
  const dialog = page.getByRole('dialog', { name: `Remove ${user.displayName}?` });
  await dialog.getByRole('button', { name: 'Remove user' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Filters the audit log to User created events.
 *
 * @param {import('@playwright/test').Page} page Admin audit page.
 */
export async function filterAuditUserCreate(page) {
  await openAdminSection(page, 'Audit');
  await page.getByLabel('Action filter').click();
  await page.getByRole('option', { name: 'User created' }).click();
}

/**
 * Asserts the bootstrap admin is listed.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 */
export async function expectBootstrapAdminListed(page) {
  await openAdminSection(page, 'Users');
  await page.getByLabel('Search users').fill(e2eEnv.adminEmail);
  await expect(page.getByText(e2eEnv.adminEmail)).toBeVisible();
}
