import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_BASE_PATH, buildApp, CORRELATION_ID_HEADER, CORRELATION_ID_PREFIX, generateCorrelationId } from '../../src/http/app.js';
import { TEST_APP_CONFIG } from '../appConfig.js';
import { MONGO_UNAVAILABLE_CODE } from '../../src/platform/mongo.js';
vi.mock('../../src/platform/mongo.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkMongoHealth: vi.fn(),
  };
});
import { checkMongoHealth } from '../../src/platform/mongo.js';
let app;
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
    expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toMatch(/^REQ-[0-9a-f]{32}$/);
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
    const previousUri = process.env.MONGODB_URI;
    const previousJwt = process.env.JWT_ACCESS_TOKEN_SECRET;
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/codex_sage_test?replicaSet=rs0';
    process.env.JWT_ACCESS_TOKEN_SECRET = 'test-jwt-access-token-secret-at-least-32-chars';
    try {
      app = buildApp();
      await app.ready();
      expect(app.hasRoute({ method: 'GET', url: `${API_BASE_PATH}/health` })).toBe(true);
    } finally {
      if (previousUri === undefined) {
        delete process.env.MONGODB_URI;
      } else {
        process.env.MONGODB_URI = previousUri;
      }
      if (previousJwt === undefined) {
        delete process.env.JWT_ACCESS_TOKEN_SECRET;
      } else {
        process.env.JWT_ACCESS_TOKEN_SECRET = previousJwt;
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
    const distRoot = mkdtempSync(path.join(tmpdir(), 'codex-sage-cors-spa-'));
    writeFileSync(path.join(distRoot, 'index.html'), '<!doctype html><html><body>spa</body></html>\n', 'utf8');
    try {
      app = buildApp({
        ...TEST_APP_CONFIG,
        env: { ...TEST_APP_CONFIG.env, isProduction: true, nodeEnv: 'production' },
        frontendDistRoot: distRoot,
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
    } finally {
      rmSync(distRoot, { recursive: true, force: true });
    }
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

  it('accepts a pre-built loggerInstance and binds method/url on request.log', async () => {
    const lines = [];
    const { buildLoggerOptions } = await import('../../src/platform/logger.js');
    const pino = (await import('pino')).default;
    const opts = buildLoggerOptions({
      ...TEST_APP_CONFIG,
      env: { ...TEST_APP_CONFIG.env, appRunningPlatform: 'container', isTest: false },
      logging: { logger: true, level: 'info', noConsoleLog: false },
    });
    const loggerInstance = pino(opts, {
      write(chunk) {
        lines.push(String(chunk));
      },
    });
    app = buildApp(
      {
        ...TEST_APP_CONFIG,
        logging: { ...TEST_APP_CONFIG.logging, logger: true, level: 'info' },
      },
      { loggerInstance },
    );
    app.get('/__log-probe', { config: { routeAccess: 'public' } }, async (request) => {
      request.log.info({ probe: true }, 'probe log');
      return { ok: true };
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/__log-probe?secret=1' });
    expect(res.statusCode).toBe(200);
    const probeLine = lines.map((line) => JSON.parse(line)).find((row) => row.msg === 'probe log');
    expect(probeLine).toMatchObject({
      level: 'info',
      method: 'GET',
      url: '/__log-probe',
      probe: true,
    });
    expect(probeLine.url).not.toContain('secret');
    expect(probeLine.pid).toBeUndefined();
    expect(probeLine.hostname).toBeUndefined();
    expect(probeLine.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('generateCorrelationId', () => {
  it('uses the configured prefix and a stable 32-hex length', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(new RegExp(`^${CORRELATION_ID_PREFIX}-[0-9a-f]{32}$`));
  });

  it('does not collide across many generations', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      seen.add(generateCorrelationId());
    }
    expect(seen.size).toBe(200);
  });
});
