import { expect, test } from '@playwright/test';

import { changePasswordViaUi, loginViaUi, signOutViaUi } from '../helpers/auth.js';
import { e2eEnv, skipLiveStack } from '../helpers/env.js';
import {
  addViewerRoleViaUi,
  createInvitedUserViaUi,
  expectBootstrapAdminListed,
  filterAuditUserCreate,
  generateE2eUser,
  openAdminSection,
  removeUserViaUi,
  setUserPasswordViaUi,
  toggleUserStatusViaUi,
} from '../helpers/admin.js';

test.describe('Journey: admin identity and audit via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  const user = generateE2eUser();

  test.beforeEach(async ({ page }) => {
    await loginViaUi(page);
  });

  test('users list includes the bootstrap admin', async ({ page }) => {
    await expectBootstrapAdminListed(page);
  });

  test('roles matrix is visible and read-only', async ({ page }) => {
    await openAdminSection(page, 'Roles & Permissions');
    await expect(page.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible();
    await expect(page.getByText('Org Admin').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Invite user|Create role|Delete/ })).toHaveCount(0);
  });

  test('creates an invited user and sets a password', async ({ page }) => {
    await createInvitedUserViaUi(page, user);
    await setUserPasswordViaUi(page, user);
    await expect(page.getByText('Active').first()).toBeVisible();
  });

  test('edits roles and toggles user status', async ({ page }) => {
    await openAdminSection(page, 'Users');
    await page.getByLabel('Search users').fill(user.email);
    await addViewerRoleViaUi(page, user);
    await expect(page.getByText('Viewer').first()).toBeVisible();
    await toggleUserStatusViaUi(page, user.email, 'Deactivate');
    await expect(page.getByText('Disabled').first()).toBeVisible();
    await toggleUserStatusViaUi(page, user.email, 'Activate');
    await expect(page.getByText('Active').first()).toBeVisible();
  });

  test('audit filter shows the user.create event', async ({ page }) => {
    await filterAuditUserCreate(page);
    await expect(page.getByText('User created').first()).toBeVisible();
  });

  test('new user must change password then can sign in', async ({ page }) => {
    await signOutViaUi(page);
    await loginViaUi(page, { email: user.email, password: user.password, expectHome: false });
    await expect(page.getByRole('heading', { name: 'Update your password' })).toBeVisible();
    await changePasswordViaUi(page, { currentPassword: user.password, newPassword: user.nextPassword });
    await loginViaUi(page, { email: user.email, password: user.nextPassword });
    await signOutViaUi(page);
    await loginViaUi(page, { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword });
  });

  test('admin removes the created user', async ({ page }) => {
    await openAdminSection(page, 'Users');
    await page.getByLabel('Search users').fill(user.email);
    await removeUserViaUi(page, user);
    await page.getByLabel('Search users').fill(user.email);
    await expect(page.getByText(user.email)).toHaveCount(0);
  });
});
