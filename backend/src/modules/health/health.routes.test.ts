import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './health.routes';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('healthRoutes', () => {
  it('returns ok liveness payload', async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api' });
  });
});
