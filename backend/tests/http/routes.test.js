import { describe, it, expect, afterEach } from 'vitest';
import { API_BASE_PATH, buildApp } from '../../src/http/app.js';
import { TEST_APP_CONFIG } from '../appConfig.js';
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
        expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/audit-events` })).toBe(true);
        expect(
            app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/audit-events/:auditEventId` }),
        ).toBe(true);
        expect(app.hasRoute({ method: 'POST', url: `${API_BASE_PATH}/projects` })).toBe(true);
        expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/projects` })).toBe(true);
        expect(
            app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/projects/:projectId` }),
        ).toBe(true);
        expect(app.hasRoute({ method: 'DELETE', url: `${API_BASE_PATH}/projects/:projectId` })).toBe(
            true,
        );
        expect(
            app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/projects/:projectId/members` }),
        ).toBe(true);
        expect(
            app.hasRoute({ method: 'POST', url: `${API_BASE_PATH}/projects/:projectId/members` }),
        ).toBe(true);
        expect(
            app.hasRoute({
                method: 'DELETE',
                url: `${API_BASE_PATH}/projects/:projectId/members/:userId`,
            }),
        ).toBe(true);
    });
});
