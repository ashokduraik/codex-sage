/**
 * Unit tests for late-bound idempotency error hooks via the Fastify error handler.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyReplay } from '../../../src/platform/idempotency/idempotency.middleware.js';
import { ApiError, registerErrorHandler, resetIdempotencyErrorHooks, setIdempotencyErrorHooks } from '../../../src/platform/errors.js';

describe('idempotencyErrorHooks', () => {
  afterEach(() => {
    resetIdempotencyErrorHooks();
  });

  /**
   * Builds a minimal app with the global error handler registered.
   * @returns {import('fastify').FastifyInstance}
   */
  function buildHookApp() {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    return app;
  }

  it('default detector recognizes IdempotencyReplay by name', async () => {
    resetIdempotencyErrorHooks();
    const app = buildHookApp();
    await app.ready();
    const reply = {
      sent: false,
      raw: { headersSent: false, writableEnded: false },
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    const request = {
      id: 'REQ-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      method: 'POST',
      url: '/masters/users/create',
      log: { error: vi.fn(), warn: vi.fn() },
    };
    await app.errorHandler(new IdempotencyReplay(201, { id: 'u1' }), request, reply);
    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith({ id: 'u1' });

    reply.status.mockClear();
    reply.send.mockClear();
    await app.errorHandler(new Error('plain'), request, reply);
    expect(reply.status).toHaveBeenCalledWith(500);
    await app.close();
  });

  it('setIdempotencyErrorHooks replaces release and detector', async () => {
    const release = vi.fn(async () => {});
    setIdempotencyErrorHooks({
      isReplayError: (error) => Boolean(error && typeof error === 'object' && /** @type {{ name?: string }} */ (error).name === 'CustomReplay'),
      releaseOwnedClaim: release,
    });
    const app = buildHookApp();
    await app.ready();
    const reply = {
      sent: false,
      raw: { headersSent: false, writableEnded: false },
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    const request = {
      id: 'REQ-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      method: 'POST',
      url: '/masters/users/create',
      log: { error: vi.fn(), warn: vi.fn() },
    };
    await app.errorHandler(/** @type {Error} */ ({ name: 'CustomReplay', responseStatus: 200, responseBody: { ok: true } }), request, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ ok: true });
    expect(release).not.toHaveBeenCalled();

    setIdempotencyErrorHooks({
      isReplayError: () => false,
      releaseOwnedClaim: release,
    });
    await app.errorHandler(ApiError.fromCode('VALIDATION_ERROR'), request, reply);
    expect(release).toHaveBeenCalled();
    await app.close();
  });
});
