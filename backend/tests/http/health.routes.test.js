import Fastify from 'fastify';
import { MONGO_UNAVAILABLE_CODE } from '../../src/platform/mongo.js';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildHealthResponse, buildReadinessResponse, healthRoutes } from '../../src/http/health.routes.js';

vi.mock('../../src/platform/mongo.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkMongoHealth: vi.fn(),
  };
});

import { checkMongoHealth } from '../../src/platform/mongo.js';

let app;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});
describe('buildHealthResponse', () => {
  it('returns ok with uptime and package version', () => {
    const body = buildHealthResponse();
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});
describe('buildReadinessResponse', () => {
  beforeEach(() => {
    vi.mocked(checkMongoHealth).mockReset();
  });
  it('returns 200 ready when mongo is up', async () => {
    vi.mocked(checkMongoHealth).mockResolvedValue({ ok: true, latencyMs: 3 });
    const result = await buildReadinessResponse();
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      status: 'ready',
      checks: { mongo: { status: 'up', latencyMs: 3 } },
    });
  });
  it('returns 503 not_ready with code-only error when mongo is down', async () => {
    vi.mocked(checkMongoHealth).mockResolvedValue({
      ok: false,
      latencyMs: 1,
      error: { code: MONGO_UNAVAILABLE_CODE },
    });
    const result = await buildReadinessResponse();
    expect(result.statusCode).toBe(503);
    expect(result.body).toEqual({
      status: 'not_ready',
      checks: {
        mongo: { status: 'down', error: { code: MONGO_UNAVAILABLE_CODE } },
      },
    });
    expect(JSON.stringify(result.body)).not.toMatch(/mongodb:\/\/|ECONN|stack/i);
  });
  it('defaults mongo error code when health result omits error', async () => {
    vi.mocked(checkMongoHealth).mockResolvedValue({ ok: false, latencyMs: 0 });
    const result = await buildReadinessResponse();
    expect(result.body.checks.mongo.error).toEqual({ code: 'MONGO_UNAVAILABLE' });
  });
});
describe('healthRoutes', () => {
  it('returns ok liveness payload', async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.version).toBe('string');
  });
  it('returns ready readiness when mongo health is ok', async () => {
    vi.mocked(checkMongoHealth).mockResolvedValue({ ok: true, latencyMs: 2 });
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    expect(res.json().checks.mongo.status).toBe('up');
  });
  it('returns 503 when mongo health fails', async () => {
    vi.mocked(checkMongoHealth).mockResolvedValue({
      ok: false,
      latencyMs: 0,
      error: { code: MONGO_UNAVAILABLE_CODE },
    });
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('not_ready');
    expect(res.body).not.toMatch(/mongodb:\/\/|hostname|stack/i);
  });
});
