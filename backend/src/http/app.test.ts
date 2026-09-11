import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_BASE_PATH, buildApp } from './app';
import { TEST_APP_CONFIG } from '../test/appConfig';
import { MONGO_UNAVAILABLE_CODE } from '../platform/mongo';

vi.mock('../platform/mongo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/mongo')>();
  return {
    ...actual,
    checkMongoHealth: vi.fn(),
  };
});

import { checkMongoHealth } from '../platform/mongo';

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.mocked(checkMongoHealth).mockResolvedValue({ ok: true, latencyMs: 1 });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

describe('buildApp', () => {
  it('serves GET /api/v1/health with the approved liveness shape', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/health` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.version).toBe('string');
  });

  it('serves unversioned GET /health as an infra alias', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('returns 404 for the old unversioned /api/health prefix', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 readiness when mongo is healthy', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/readiness` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      checks: { mongo: { status: 'up', latencyMs: 1 } },
    });
  });

  it('returns 503 readiness when mongo ping fails', async () => {
    vi.mocked(checkMongoHealth).mockResolvedValue({
      ok: false,
      latencyMs: 2,
      error: { code: MONGO_UNAVAILABLE_CODE },
    });
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/readiness` });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('not_ready');
    expect(res.json().checks.mongo.error.code).toBe(MONGO_UNAVAILABLE_CODE);
    expect(res.body).not.toMatch(/mongodb:\/\/|ECONN|stack/i);
  });

  it('serves unversioned GET /readiness', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });

  it('builds with the default config without throwing when env is valid', async () => {
    const previous = process.env.MONGODB_URI;
    process.env.MONGODB_URI =
      'mongodb://127.0.0.1:27017/codex_sage_test?replicaSet=rs0';
    try {
      app = buildApp();
      await app.ready();
      expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/health` })).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.MONGODB_URI;
      } else {
        process.env.MONGODB_URI = previous;
      }
    }
  });

  it('decorates the Fastify instance with the resolved config', async () => {
    app = buildApp(TEST_APP_CONFIG);
    await app.ready();
    expect(app.config).toMatchObject({
      server: { host: '127.0.0.1' },
      env: { nodeEnv: 'test' },
    });
  });

  it('enables CORS outside production', async () => {
    app = buildApp({
      ...TEST_APP_CONFIG,
      env: { ...TEST_APP_CONFIG.env, isProduction: false, nodeEnv: 'development' },
    });
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS',
      url: `${API_BASE_PATH}/health`,
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('skips CORS registration in production', async () => {
    app = buildApp({
      ...TEST_APP_CONFIG,
      env: { ...TEST_APP_CONFIG.env, isProduction: true, nodeEnv: 'production' },
    });
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS',
      url: `${API_BASE_PATH}/health`,
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
      env: { ...TEST_APP_CONFIG.env, appRunningPlatform: 'container' },
      logging: {
        ...TEST_APP_CONFIG.logging,
        logger: true,
        level: 'debug',
      },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/health` });
    expect(res.statusCode).toBe(200);
  });
});
