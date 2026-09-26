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
    const checkbox = dialog.getByLabel(label, { exact: true });
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
  }
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(role.name, { exact: true }).filter({ visible: true }).first()).toBeVisible();
}

/**
 * Edits an existing role's name and toggles one permission label on.
 *
 * @param {import('@playwright/test').Page} page Authenticated page.
 * @param {{ currentName: string, nextName?: string, enablePermissionLabels?: string[] }} input Edit fields.
 */
export async function editRoleViaUi(page, input) {
  await openAdminSection(page, 'Roles & Permissions');
  const named = page.locator('span.text-center', { hasText: input.currentName }).first();
  if (await named.count()) {
    await named.getByRole('button', { name: 'Edit role' }).click();
  } else {
    await page.getByRole('region', { name: input.currentName }).getByRole('button', { name: 'Edit role' }).click();
  }
  const dialog = page.getByRole('dialog').filter({ hasText: input.currentName });
  await expect(dialog).toBeVisible();
  if (input.nextName) {
    await dialog.locator('#admin-role-name').fill(input.nextName);
  }
  for (const label of input.enablePermissionLabels ?? []) {
    const checkbox = dialog.getByLabel(label, { exact: true });
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
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
  await page.getByRole('button', { name: 'Delete role' }).first().click();
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
 * @param {{ roleName: string }} assignment Role to assign.
 */
export async function createInvitedUserViaUi(page, user, assignment) {
  await openAdminSection(page, 'Users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create user' });
  await expect(dialog).toBeVisible();
  await dialog.locator('#admin-create-name').fill(user.displayName);
  await dialog.locator('#admin-create-email').fill(user.email);
  await dialog.locator('#admin-create-code').fill(user.code);
  const assigned = dialog.getByLabel(assignment.roleName, { exact: true });
  if (!(await assigned.isChecked())) {
    await assigned.check();
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
  await row.getByLabel('Actions').click();
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
  await openUserRowActions(page, email);
  const menuItem = page.getByRole('button', { name: action, exact: true });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
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
  await page.getByRole('button', { name: 'Edit roles' }).click();
  const dialog = page.getByRole('dialog', { name: `Edit roles for ${user.displayName}` });
  const extra = dialog.getByLabel(assignment.roleName, { exact: true });
  if (!(await extra.isChecked())) {
    await extra.check();
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
