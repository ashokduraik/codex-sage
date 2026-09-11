import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { TEST_APP_CONFIG } from '../test/appConfig';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('registerRoutes', () => {
  it('registers health under the /api prefix', async () => {
    app = buildApp(TEST_APP_CONFIG);
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/api/health' })).toBe(true);
  });
});
