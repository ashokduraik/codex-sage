import { createRequire } from 'node:module';
import { checkMongoHealth } from '../../platform/mongo.js';
const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../../../package.json');
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
 * Fastify plugin that registers `/health` and `/readiness` on the given instance.
 * Mounted both under `API_BASE_PATH` and at the root for infra probes.
 * @param app - The Fastify application instance to register the routes on.
 */
export async function healthRoutes(app) {
    app.get(
        '/health',
        { config: { routeAccess: 'public' } },
        async () => {
            return buildHealthResponse();
        },
    );
    app.get(
        '/readiness',
        { config: { routeAccess: 'public' } },
        async (_request, reply) => {
            const { statusCode, body } = await buildReadinessResponse();
            return reply.status(statusCode).send(body);
        },
    );
}
