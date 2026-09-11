import { describe, it, expect, afterEach } from 'vitest';
import { API_BASE_PATH, buildApp } from './app.js';
import { TEST_APP_CONFIG } from '../test/appConfig.js';
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
    });
});
