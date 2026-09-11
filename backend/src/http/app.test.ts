import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { TEST_APP_CONFIG } from '../test/appConfig';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('buildApp', () => {
  it('serves GET /api/health', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api' });
  });

  it('builds with the default config without throwing', async () => {
    // NODE_ENV is 'test' under vitest → default config disables the logger.
    app = buildApp();
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/api/health' })).toBe(true);
  });

  it('decorates the Fastify instance with the resolved config', async () => {
    app = buildApp(TEST_APP_CONFIG);
    await app.ready();
    expect(app.config).toMatchObject({ host: '127.0.0.1', nodeEnv: 'test' });
  });

  it('enables CORS outside production', async () => {
    app = buildApp({ ...TEST_APP_CONFIG, nodeEnv: 'development' });
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('skips CORS registration in production', async () => {
    app = buildApp({ ...TEST_APP_CONFIG, nodeEnv: 'production' });
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('registers request logging hooks when logger is enabled', async () => {
    app = buildApp({
      ...TEST_APP_CONFIG,
      logger: true,
      appRunningPlatform: 'container',
      logLevel: 'debug',
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
