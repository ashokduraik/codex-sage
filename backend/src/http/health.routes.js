/**
 * Health and readiness HTTP adapters — liveness and dependency probes.
 * URL registration lives in `http/route.js`.
 */
import { createRequire } from 'node:module';
import { checkMongoHealth } from '../platform/mongo.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../../package.json');

/**
 * Builds the liveness payload (no dependency checks).
 * @returns Health response with process uptime and package version.
 */
export function buildHealthResponse() {
  return {
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    version: PACKAGE_VERSION,
  };
}

/**
 * Runs dependency checks and builds the readiness payload.
 * @returns Status code and readiness body (never includes driver text or URIs).
 */
export async function buildReadinessResponse() {
  const mongo = await checkMongoHealth();
  if (mongo.ok) {
    return {
      statusCode: 200,
      body: {
        status: 'ready',
        checks: {
          mongo: { status: 'up', latencyMs: mongo.latencyMs },
        },
      },
    };
  }
  return {
    statusCode: 503,
    body: {
      status: 'not_ready',
      checks: {
        mongo: {
          status: 'down',
          error: { code: mongo.error?.code ?? 'MONGO_UNAVAILABLE' },
        },
      },
    },
  };
}

/**
 * GET /health — liveness (no dependency checks).
 * @returns Liveness payload.
 */
export async function getHealthHttp() {
  return buildHealthResponse();
}

/**
 * GET /readiness — Mongo dependency probe.
 * @param {import('fastify').FastifyRequest} _request Unused request.
 * @param {import('fastify').FastifyReply} reply Reply used for non-200 status.
 * @returns Readiness body (status set on reply when not ready).
 */
export async function getReadinessHttp(_request, reply) {
  const { statusCode, body } = await buildReadinessResponse();
  return reply.status(statusCode).send(body);
}
