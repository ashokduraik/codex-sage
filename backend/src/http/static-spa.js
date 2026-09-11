/**
 * Production-only SPA hosting: serve `frontend/dist` and fall back to `index.html`.
 * Development never registers static files (Vite HMR owns the UI process).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the Vite production build output (monorepo `frontend/dist`).
 * Named constant — not an env var (D13 / env-config).
 */
export const FRONTEND_DIST_ROOT = path.resolve(moduleDir, '../../../frontend/dist');

/**
 * True when the URL path is under the API surface (versioned or otherwise).
 * SPA fallback must not swallow these — they keep the JSON error envelope.
 * @param {string} urlPath Pathname without query string.
 * @returns {boolean}
 */
export function isApiUrlPath(urlPath) {
  return urlPath === '/api' || urlPath.startsWith('/api/');
}

/**
 * Asserts the production dist directory contains `index.html`.
 * @param {string} distRoot Absolute path to `frontend/dist`.
 * @throws {Error} When the directory or index.html is missing.
 */
export function assertFrontendDistPresent(distRoot) {
  const indexPath = path.join(distRoot, 'index.html');
  if (!existsSync(distRoot) || !existsSync(indexPath)) {
    throw new Error(
      `Production SPA dist is missing. Expected index.html at ${indexPath}. ` +
        'Run `npm run build` in frontend/ before starting the API.',
    );
  }
}

/**
 * Resolves the dist root for production, asserting `index.html` exists.
 * @param {{ isProduction: boolean, frontendDistRoot?: string }} envConfig Env flags + optional test root.
 * @returns {string | undefined} Dist root when production; otherwise undefined.
 */
export function resolveProductionDistRoot(envConfig) {
  if (!envConfig.isProduction) {
    return undefined;
  }
  const distRoot = envConfig.frontendDistRoot ?? FRONTEND_DIST_ROOT;
  assertFrontendDistPresent(distRoot);
  return distRoot;
}

/**
 * Not-found hook for production: serve `index.html` for safe non-API navigations.
 * Returns `undefined` so the platform JSON 404 runs for API paths and non-GET/HEAD.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @param {import('fastify').FastifyReply} reply Reply (must have `sendFile` from `@fastify/static`).
 * @returns {unknown}
 */
export function tryServeSpaIndex(request, reply) {
  const urlPath = request.url.split('?')[0] ?? request.url;
  const method = request.method.toUpperCase();
  const isSafeNavigation = method === 'GET' || method === 'HEAD';
  if (!isSafeNavigation || isApiUrlPath(urlPath)) {
    return undefined;
  }
  return reply.sendFile('index.html');
}

/**
 * Registers `@fastify/static` on the root app when a production dist root is provided.
 * @param {import('fastify').FastifyInstance} app Fastify instance.
 * @param {string | undefined} distRoot Absolute path to `frontend/dist`, or undefined to skip.
 */
export function registerStaticAssets(app, distRoot) {
  if (!distRoot) {
    return;
  }
  void app.register(fastifyStatic, {
    root: distRoot,
    // Let missing files fall through to the not-found handler (SPA fallback).
    wildcard: false,
  });
}
