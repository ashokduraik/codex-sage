import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { API_BASE_PATH, buildApp, CORRELATION_ID_HEADER } from '../../src/http/app.js';
import { TEST_APP_CONFIG } from '../appConfig.js';
import { assertFrontendDistPresent, FRONTEND_DIST_ROOT, isApiUrlPath } from '../../src/http/static-spa.js';

vi.mock('../../src/platform/mongo.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkMongoHealth: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };
});

/**
 * Creates a temporary Vite-like dist directory with index.html and a sample asset.
 * @returns {string} Absolute path to the temp dist root.
 */
function createTempDist() {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-sage-spa-'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body>spa-index</body></html>\n', 'utf8');
  const assetsDir = path.join(root, 'assets');
  mkdirSync(assetsDir);
  writeFileSync(path.join(assetsDir, 'app.js'), 'console.log("asset");\n', 'utf8');
  return root;
}

describe('isApiUrlPath', () => {
  it('treats /api and /api/* as API paths', () => {
    expect(isApiUrlPath('/api')).toBe(true);
    expect(isApiUrlPath('/api/v1/unknown')).toBe(true);
    expect(isApiUrlPath('/projects')).toBe(false);
    expect(isApiUrlPath('/')).toBe(false);
  });
});

describe('assertFrontendDistPresent', () => {
  it('throws a readable error when dist or index.html is missing', () => {
    const missing = path.join(tmpdir(), `codex-sage-missing-${Date.now()}`);
    expect(() => assertFrontendDistPresent(missing)).toThrow(/Production SPA dist is missing/);
    expect(() => assertFrontendDistPresent(missing)).toThrow(missing);
  });

  it('exposes FRONTEND_DIST_ROOT as an absolute path ending in frontend/dist', () => {
    expect(path.isAbsolute(FRONTEND_DIST_ROOT)).toBe(true);
    expect(FRONTEND_DIST_ROOT.replace(/\\/g, '/')).toMatch(/frontend\/dist$/);
  });
});

describe('static SPA (production)', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;
  /** @type {string | undefined} */
  let distRoot;

  beforeEach(() => {
    distRoot = createTempDist();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (distRoot) {
      rmSync(distRoot, { recursive: true, force: true });
      distRoot = undefined;
    }
  });

  /**
   * Builds a production app pointed at the temp dist fixture.
   * @returns {import('fastify').FastifyInstance}
   */
  function buildProductionApp() {
    return buildApp({
      ...TEST_APP_CONFIG,
      env: { ...TEST_APP_CONFIG.env, isProduction: true, nodeEnv: 'production' },
      frontendDistRoot: distRoot,
    });
  }

  it('serves index.html at GET / and hashed assets from dist', async () => {
    app = buildProductionApp();
    const indexRes = await app.inject({ method: 'GET', url: '/' });
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.body).toContain('spa-index');

    const assetRes = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.body).toContain('console.log');
  });

  it('returns index.html for a client-route GET with no matching file', async () => {
    app = buildProductionApp();
    const res = await app.inject({ method: 'GET', url: '/projects/abc' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-index');
  });

  it('keeps the JSON error envelope for unknown GET /api/v1 paths', async () => {
    app = buildProductionApp();
    const res = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/no-such-route` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toMatch(/^REQ-/);
    expect(res.body).not.toContain('spa-index');
  });

  it('does not SPA-fallback non-GET methods under a client path', async () => {
    app = buildProductionApp();
    const res = await app.inject({ method: 'POST', url: '/projects' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('fails registration when dist is missing', () => {
    const missing = path.join(tmpdir(), `codex-sage-absent-${Date.now()}`);
    expect(() =>
      buildApp({
        ...TEST_APP_CONFIG,
        env: { ...TEST_APP_CONFIG.env, isProduction: true, nodeEnv: 'production' },
        frontendDistRoot: missing,
      }),
    ).toThrow(/Production SPA dist is missing/);
  });
});

describe('static SPA (non-production)', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('does not register static — GET / is not the SPA', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
