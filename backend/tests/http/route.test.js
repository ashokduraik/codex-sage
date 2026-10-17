import { TEST_APP_CONFIG } from '../appConfig.js';
import { describe, it, expect, afterEach } from 'vitest';
import { API_BASE_PATH, buildApp } from '../../src/http/app.js';

let app;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
describe('registerRoutes', () => {
  it('registers health under the /api/v1 prefix', async () => {
    app = buildApp(TEST_APP_CONFIG);
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/health` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/readiness` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/access/audit/list` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/access/audit/get/:auditEventId` })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: `${API_BASE_PATH}/masters/projects/create` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/masters/projects/list` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/masters/projects/get/:projectId` })).toBe(true);
    expect(app.hasRoute({ method: 'DELETE', url: `${API_BASE_PATH}/masters/projects/delete/:projectId` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/masters/projectMembers/list/:projectId` })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: `${API_BASE_PATH}/masters/projectMembers/create/:projectId` })).toBe(true);
    expect(
      app.hasRoute({
        method: 'DELETE',
        url: `${API_BASE_PATH}/masters/projectMembers/delete/:projectId/:userId`,
      }),
    ).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/masters/notifications/list` })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: `${API_BASE_PATH}/masters/notifications/markRead/:notificationId` })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: `${API_BASE_PATH}/masters/notifications/markAllRead` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/masters/projectActivities/getOrganizationUsage` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/masters/projectActivities/getProjectUsage/:projectId` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/masters/projectActivities/getMyUsage` })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: `${API_BASE_PATH}/access/auth/login` })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/access/permissions/list` })).toBe(true);
    expect(
      app.hasRoute({
        method: 'POST',
        url: `${API_BASE_PATH}/conversation/conversation/create/:projectId`,
      }),
    ).toBe(true);
    expect(
      app.hasRoute({
        method: 'POST',
        url: `${API_BASE_PATH}/conversation/chatStream/streamMessage/:projectId/:conversationId`,
      }),
    ).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/knowledge/search/run/:projectId` })).toBe(true);
  });
});
