import { expect, test } from '@playwright/test';

import { changePasswordViaUi, loginViaUi, signOutViaUi } from '../helpers/auth.js';
import { e2eEnv, skipLiveStack } from '../helpers/env.js';
import {
  addRoleViaUi,
  createInvitedUserViaUi,
  createRoleViaUi,
  editRoleViaUi,
  expectBootstrapAdminListed,
  expectUserStatus,
  filterAuditUserCreate,
  generateE2eUser,
  openAdminSection,
  removeUserViaUi,
  setUserPasswordViaUi,
  toggleUserStatusViaUi,
  userRow,
} from '../helpers/admin.js';

test.describe('Journey: admin identity and audit via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  const user = generateE2eUser();
  const stamp = Date.now();
  const memberRole = {
    code: `E2E-MEMBER-${stamp}`,
    name: `E2E Member ${stamp}`,
    permissionLabels: ['View organization', 'View projects', 'Ask questions'],
  };
  const extraRole = {
    code: `E2E-EXTRA-${stamp}`,
    name: `E2E Extra ${stamp}`,
    permissionLabels: ['View organization'],
  };

  test.beforeEach(async ({ page }) => {
    await loginViaUi(page);
  });

  test('users list includes the bootstrap admin', async ({ page }) => {
    await expectBootstrapAdminListed(page);
  });

  test('creates and edits custom roles from the matrix page', async ({ page }) => {
    await createRoleViaUi(page, memberRole);
    await createRoleViaUi(page, extraRole);
    await expect(page.getByText('Org Admin', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await editRoleViaUi(page, {
      currentName: extraRole.name,
      enablePermissionLabels: ['View projects'],
    });
  });

  test('creates an invited user and sets a password', async ({ page }) => {
    await createInvitedUserViaUi(page, user, { roleName: memberRole.name });
    await setUserPasswordViaUi(page, user);
    await expect(page.getByText(user.email)).toBeVisible();
    await expect(userRow(page, user.email).getByText(user.code, { exact: true })).toBeVisible();
  });

  test('edits roles and toggles user status', async ({ page }) => {
    await openAdminSection(page, 'Users');
    await page.getByLabel('Search users').fill(user.email);
    await addRoleViaUi(page, user, { roleName: extraRole.name });
    await expect(userRow(page, user.email).getByText(extraRole.name, { exact: true })).toBeVisible();
    if (await userRow(page, user.email).getByText('Invited', { exact: true }).isVisible()) {
      await toggleUserStatusViaUi(page, user.email, 'Activate');
    }
    await expectUserStatus(page, user.email, 'Active');
    await toggleUserStatusViaUi(page, user.email, 'Deactivate');
    await expectUserStatus(page, user.email, 'Disabled');
    await toggleUserStatusViaUi(page, user.email, 'Activate');
    await expectUserStatus(page, user.email, 'Active');
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
