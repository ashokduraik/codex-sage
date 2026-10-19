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
import {
  cancelFollowUpAndCreateDialogs,
  cleanupCreatedProjects,
  createProjectViaUi,
  generateE2eProjectName,
  openProjectFromList,
  searchProjectsFor,
} from '../helpers/projects.js';

test.describe('Journey: admin identity and audit via UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(skipLiveStack, 'E2E_SKIP=1 — live-stack journey specs disabled');

  const user = generateE2eUser();
  const stamp = Date.now();
  const rbacProjectName = generateE2eProjectName();
  /** @type {string | undefined} */
  let rbacProjectId;
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

  test.afterAll(async ({ browser }) => {
    await cleanupCreatedProjects(browser, [rbacProjectName]);
  });

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

  test('creates an RBAC project for the chat-limited member', async ({ page }) => {
    await createProjectViaUi(page, rbacProjectName, 'upload');
    await cancelFollowUpAndCreateDialogs(page);
    await searchProjectsFor(page, rbacProjectName);
    await expect(page.getByRole('heading', { name: rbacProjectName, level: 3 })).toBeVisible();
    const href = await page
      .locator('a[href^="/projects/"]')
      .filter({ has: page.getByRole('heading', { name: rbacProjectName, level: 3 }) })
      .getAttribute('href');
    rbacProjectId = href?.split('/').pop();
    expect(rbacProjectId).toBeTruthy();
  });

  test('creates an invited user and sets a password', async ({ page }) => {
    await createInvitedUserViaUi(page, user, {
      roleName: memberRole.name,
      projectAccessMode: 'All projects',
    });
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

  test('chat-limited member is denied admin and gated project tabs', async ({ page }) => {
    if (!rbacProjectId) {
      throw new Error('RBAC project id missing from earlier step');
    }

    await signOutViaUi(page);
    await loginViaUi(page, { email: user.email, password: user.password, expectHome: false });
    await expect(page.getByRole('heading', { name: 'Update your password' })).toBeVisible();
    await changePasswordViaUi(page, { currentPassword: user.password, newPassword: user.nextPassword });
    await loginViaUi(page, { email: user.email, password: user.nextPassword });

    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project' })).toHaveCount(0);

    await searchProjectsFor(page, rbacProjectName);
    await openProjectFromList(page, rbacProjectName);

    const projectNav = page.getByRole('main').getByRole('navigation');
    await expect(projectNav.getByRole('link', { name: 'Chat', exact: true })).toBeVisible();
    await expect(projectNav.getByRole('link', { name: 'Overview', exact: true })).toBeVisible();
    await expect(projectNav.getByRole('link', { name: 'Health', exact: true })).toHaveCount(0);
    await expect(projectNav.getByRole('link', { name: 'Sources', exact: true })).toHaveCount(0);
    await expect(projectNav.getByRole('link', { name: 'Knowledge', exact: true })).toHaveCount(0);
    await expect(projectNav.getByRole('link', { name: 'Search', exact: true })).toHaveCount(0);
    await expect(projectNav.getByRole('link', { name: 'Changes', exact: true })).toHaveCount(0);

    await page.goto(`/projects/${rbacProjectId}/health`);
    await expect(page.getByRole('alert').filter({ hasText: /permission to view/i })).toBeVisible();
    await page.goto(`/projects/${rbacProjectId}/sources`);
    await expect(page.getByRole('alert').filter({ hasText: /permission to view/i })).toBeVisible();

    await page.goto(`/projects/${rbacProjectId}/chat`);
    await expect(page.getByPlaceholder('Ask anything about this project…')).toBeVisible();

    await page.goto('/admin/users');
    await expect(page.getByRole('alert').filter({ hasText: /permission to perform this action/i })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Audit', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Usage', exact: true })).toHaveCount(0);
    await page.goto('/admin/roles');
    await expect(page.getByRole('alert').filter({ hasText: /permission to perform this action/i })).toBeVisible();

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
