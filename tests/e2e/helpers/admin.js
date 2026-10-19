import { expect } from '@playwright/test';

import { e2eEnv } from './env.js';

/**
 * Builds a unique invited-user identity (must be a real TLD — `.localhost` fails zod email).
 *
 * @returns {{ displayName: string, email: string, password: string, nextPassword: string, code: string }}
 */
export function generateE2eUser() {
  const stamp = Date.now();
  return {
    displayName: `E2E User ${stamp}`,
    email: `e2e-${stamp}@example.com`,
    password: 'E2E-pass-1',
    nextPassword: 'E2E-pass-2',
    code: `E2E-${stamp}`,
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
 * Sets a visually-hidden permission/role checkbox via DOM click.
 * The input is `sr-only` (often outside the viewport) and its wrapping label intercepts
 * Playwright pointer actions, so a native element.click() is the reliable path.
 *
 * @param {import('@playwright/test').Locator} scope Dialog or page region.
 * @param {string} label Accessible name on the checkbox.
 * @param {boolean} checked Desired checked state.
 */
async function setLabeledCheckbox(scope, label, checked) {
  const checkbox = scope.getByLabel(label, { exact: true });
  if ((await checkbox.isChecked()) === checked) {
    return;
  }
  await checkbox.evaluate((element) => {
    element.click();
  });
  if (checked) {
    await expect(checkbox).toBeChecked();
  } else {
    await expect(checkbox).not.toBeChecked();
  }
}

/**
 * Creates a role from the Roles & Permissions page.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {{ code: string, name: string, permissionLabels: string[] }} role Role fields.
 */
export async function createRoleViaUi(page, role) {
  await openAdminSection(page, 'Roles & Permissions');
  await page.getByRole('button', { name: 'Create role' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create role' });
  await expect(dialog).toBeVisible();
  await dialog.locator('#admin-role-code').fill(role.code);
  await dialog.locator('#admin-role-name').fill(role.name);
  for (const label of role.permissionLabels) {
    await setLabeledCheckbox(dialog, label, true);
  }
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(role.name, { exact: true }).filter({ visible: true }).first()).toBeVisible();
}

/**
 * Locates a roles-table row by display name.
 *
 * @param {import('@playwright/test').Page} page Roles page.
 * @param {string} name Role name.
 * @returns {import('@playwright/test').Locator} Row locator.
 */
export function roleRow(page, name) {
  return page.locator('div.grid.grid-cols-1').filter({ hasText: name });
}

/**
 * Edits an existing role's name and toggles one permission label on.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {{ currentName: string, nextName?: string, enablePermissionLabels?: string[] }} input Edit fields.
 */
export async function editRoleViaUi(page, input) {
  await openAdminSection(page, 'Roles & Permissions');
  await roleRow(page, input.currentName).getByRole('button', { name: 'Edit role' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: input.currentName });
  await expect(dialog).toBeVisible();
  if (input.nextName) {
    await dialog.locator('#admin-role-name').fill(input.nextName);
  }
  for (const label of input.enablePermissionLabels ?? []) {
    await setLabeledCheckbox(dialog, label, true);
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Soft-deletes a role that is not assigned to a user.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {{ name: string }} role Role to delete.
 */
export async function deleteRoleViaUi(page, role) {
  await openAdminSection(page, 'Roles & Permissions');
  await roleRow(page, role.name).getByRole('button', { name: 'Delete role' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete ${role.name}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete role' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Creates an invited user assigned a role created in this journey.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {{ displayName: string, email: string, code: string }} user Identity.
 * @param {{
 *   roleName: string,
 *   projectAccessMode?: 'All projects' | 'Selected projects only' | 'No projects',
 * }} assignment Role and optional project access.
 */
export async function createInvitedUserViaUi(page, user, assignment) {
  await openAdminSection(page, 'Users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create user' });
  await expect(dialog).toBeVisible();
  await dialog.locator('#admin-create-name').fill(user.displayName);
  await dialog.locator('#admin-create-email').fill(user.email);
  await dialog.locator('#admin-create-code').fill(user.code);
  await setLabeledCheckbox(dialog, assignment.roleName, true);
  await setLabeledCheckbox(dialog, 'Org Admin', false);
  if (assignment.projectAccessMode) {
    await dialog.getByLabel('Project access', { exact: true }).click();
    await page.getByRole('option', { name: assignment.projectAccessMode, exact: true }).click();
  }
  const inviteButton = dialog.getByRole('button', { name: 'Invite user' });
  await inviteButton.evaluate((element) => {
    element.click();
  });
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Search users').fill(user.email);
  await expect(page.getByText(user.email)).toBeVisible();
}

/**
 * Locates the users-table row for an email.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {string} email User email.
 * @returns {import('@playwright/test').Locator} Row locator.
 */
export function userRow(page, email) {
  return page.locator('div.grid.grid-cols-1').filter({ hasText: email });
}

/**
 * Asserts a user's status badge (exact, row-scoped so "Activate" is not matched).
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {string} email User email.
 * @param {string} status Visible status (`Invited`, `Active`, `Disabled`).
 */
export async function expectUserStatus(page, email, status) {
  await expect(userRow(page, email).getByText(status, { exact: true })).toBeVisible();
}

/**
 * Opens the row actions menu for a user email.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {string} email User email.
 */
export async function openUserRowActions(page, email) {
  const row = userRow(page, email);
  await expect(row).toBeVisible();
  const editRoles = page.getByRole('button', { name: 'Edit roles', exact: true });
  if (await editRoles.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(editRoles).toHaveCount(0);
  }
  await row.getByLabel('Actions').click();
  await expect(editRoles).toBeVisible();
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
  await page.getByRole('button', { name: 'Reset password' }).click({ force: true });
  const dialog = page.getByRole('dialog', { name: `Set password for ${user.displayName}` });
  await dialog.locator('#admin-new-password').fill(user.password);
  await dialog.locator('#admin-confirm-password').fill(user.password);
  await dialog.getByRole('button', { name: 'Set password' }).click();
  await expect(dialog.getByRole('status')).toContainText('Password set completed');
  await dialog.getByRole('button', { name: 'Close' }).first().click();
}

/**
 * Toggles activate / deactivate for a user.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {string} email User email.
 * @param {'Deactivate' | 'Activate'} action Menu label.
 */
export async function toggleUserStatusViaUi(page, email, action) {
  const nextStatus = action === 'Activate' ? 'Active' : 'Disabled';
  await openUserRowActions(page, email);
  const menuItem = page.getByRole('button', { name: action, exact: true });
  await expect(menuItem).toBeVisible();
  // Headless Chromium treats the animated popover as never-stable; the click still lands.
  await menuItem.click({ force: true });
  await expect(menuItem).toHaveCount(0);
  await expectUserStatus(page, email, nextStatus);
}

/**
 * Assigns an extra role (by display name) to a user.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 * @param {{ displayName: string, email: string }} user Target.
 * @param {{ roleName: string }} assignment Role to add.
 */
export async function addRoleViaUi(page, user, assignment) {
  await openUserRowActions(page, user.email);
  await page.getByRole('button', { name: 'Edit roles' }).click({ force: true });
  const dialog = page.getByRole('dialog', { name: `Edit roles for ${user.displayName}` });
  await setLabeledCheckbox(dialog, assignment.roleName, true);
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
  await page.getByRole('button', { name: 'Remove user' }).click({ force: true });
  const dialog = page.getByRole('dialog', { name: `Remove ${user.displayName}?` });
  await dialog.getByRole('button', { name: 'Remove user' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Filters the audit log to User created events for today, then searches.
 *
 * @param {import('@playwright/test').Page} page Admin audit page.
 */
export async function filterAuditUserCreate(page) {
  await openAdminSection(page, 'Audit');
  const today = new Date();
  const todayKey = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
  /**
   * Picks today in the open calendar popover, then waits for it to close so the
   * next field does not leave two day buttons with the same aria-label.
   * @param {string} fieldLabel Accessible name of the date trigger.
   */
  async function pickTodayInDateField(fieldLabel) {
    await page.getByLabel(fieldLabel).click();
    const calendar = page.locator('[data-radix-popper-content-wrapper]').last();
    await calendar.getByRole('button', { name: todayKey }).click();
    await expect(calendar).toBeHidden();
  }
  await pickTodayInDateField('From date');
  await pickTodayInDateField('To date');
  await page.getByLabel('Action filter').click();
  await page.getByRole('option', { name: 'User created' }).click();
  await page.getByRole('button', { name: 'Search' }).click();
}

/**
 * Asserts the bootstrap admin is listed with code ADMIN.
 *
 * @param {import('@playwright/test').Page} page Admin users page.
 */
export async function expectBootstrapAdminListed(page) {
  await openAdminSection(page, 'Users');
  await page.getByLabel('Search users').fill(e2eEnv.adminEmail);
  await expect(page.getByText(e2eEnv.adminEmail)).toBeVisible();
  await expect(userRow(page, e2eEnv.adminEmail).getByText('ADMIN', { exact: true })).toBeVisible();
}
