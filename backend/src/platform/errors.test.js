import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ApiError,
  buildErrorEnvelope,
  canSendJsonError,
} from './errors.js';
import { buildApp, CORRELATION_ID_HEADER } from '../http/app.js';
import { TEST_APP_CONFIG } from '../test/appConfig.js';
import { getCorrelationId } from './requestContext.js';

describe('ApiError', () => {
  it('constructs with statusCode, code, and message', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'email is required');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('email is required');
    expect(err.details).toBeUndefined();
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores optional details when provided', () => {
    const details = { field: 'email' };
    const err = new ApiError(400, 'VALIDATION_ERROR', 'invalid', details);
    expect(err.details).toEqual(details);
  });

  it('fromCode uses the catalog status and message', () => {
    const err = ApiError.fromCode('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('You do not have permission to perform this action.');
  });

  it('fromCode throws for unknown codes', () => {
    expect(() => ApiError.fromCode('NOT_A_CODE')).toThrow(/Unknown error code/);
  });
});

describe('canSendJsonError', () => {
  it('returns false when headers were already sent', () => {
    const reply = {
      sent: false,
      raw: { headersSent: true, writableEnded: false },
    };
    expect(canSendJsonError(reply)).toBe(false);
  });

  it('returns false when the reply was already sent or ended', () => {
    expect(
      canSendJsonError({
        sent: true,
        raw: { headersSent: false, writableEnded: false },
      }),
    ).toBe(false);
    expect(
      canSendJsonError({
        sent: false,
        raw: { headersSent: false, writableEnded: true },
      }),
    ).toBe(false);
  });

  it('returns true when a JSON body can still be written', () => {
    expect(
      canSendJsonError({
        sent: false,
        raw: { headersSent: false, writableEnded: false },
      }),
    ).toBe(true);
  });
});

describe('buildErrorEnvelope', () => {
  it('builds the full envelope for a known ApiError', () => {
    const err = ApiError.fromCode('VALIDATION_ERROR', {
      details: { field: 'email' },
    });
    const mapped = buildErrorEnvelope(err, 'REQ-ref');
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      class: 'user',
      retryability: 'user_action_required',
      message: 'Request validation failed.',
      reference: 'REQ-ref',
      details: { field: 'email' },
    });
  });

  it('maps unknown ApiError codes to INTERNAL_ERROR', () => {
    const err = new ApiError(422, 'INVALID_PAYLOAD', 'bad data', { field: 'x' });
    const mapped = buildErrorEnvelope(err, 'REQ-x');
    expect(mapped.unknownCode).toBe(true);
    expect(mapped.body.error.code).toBe('INTERNAL_ERROR');
    expect(mapped.body.error.message).toBe('Internal server error');
    expect(mapped.body.error.details).toBeUndefined();
  });

  it('maps generic Error to INTERNAL_ERROR without leaking the message', () => {
    const mapped = buildErrorEnvelope(new Error('boom secret'), 'REQ-y');
    expect(mapped.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      class: 'system',
      message: 'Internal server error',
      reference: 'REQ-y',
    });
  });

  it('maps statusCode 404 to NOT_FOUND and keeps known 5xx ApiError messages', () => {
    const notFound = buildErrorEnvelope(
      Object.assign(new Error('missing'), { statusCode: 404 }),
      'REQ-404',
    );
    expect(notFound.body.error.code).toBe('NOT_FOUND');
    expect(notFound.statusCode).toBe(404);

    const knowledge = buildErrorEnvelope(
      ApiError.fromCode('KNOWLEDGE_UNAVAILABLE'),
      'REQ-k',
    );
    expect(knowledge.statusCode).toBe(503);
    expect(knowledge.body.error.message).toBe('Project knowledge is being updated.');
    expect(knowledge.body.error.retryability).toBe('temporary');
  });
});

describe('registerErrorHandler (integration via buildApp)', () => {
  let app;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 404 NOT_FOUND with full envelope and matching header', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({ method: 'GET', url: '/nonexistent' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatchObject({
      code: 'NOT_FOUND',
      class: 'user',
      retryability: 'user_action_required',
    });
    expect(body.error.reference).toMatch(/^REQ-[0-9a-f]{32}$/);
    expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toBe(body.error.reference);
  });

  it('returns 500 INTERNAL_ERROR for unhandled generic errors', async () => {
    app = buildApp(TEST_APP_CONFIG);
    app.get('/boom', async () => {
      throw new Error('something broke');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        class: 'system',
        retryability: 'permanent',
        message: 'Internal server error',
      },
    });
    expect(res.json().error.message).not.toBe('something broke');
  });

  it('returns catalog ApiError fields including allowlisted details', async () => {
    app = buildApp(TEST_APP_CONFIG);
    app.get('/custom', async () => {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        message: 'email is required',
        details: { field: 'email' },
      });
    });
    const res = await app.inject({ method: 'GET', url: '/custom' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        class: 'user',
        retryability: 'user_action_required',
        message: 'email is required',
        details: { field: 'email' },
      },
    });
    expect(res.json().error.details).not.toHaveProperty('value');
  });

  it('maps non-ApiError 4xx to VALIDATION_ERROR', async () => {
    app = buildApp(TEST_APP_CONFIG);
    app.get('/badreq', async () => {
      const err = Object.assign(new Error('bad request'), { statusCode: 400 });
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/badreq' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', class: 'user' },
    });
  });

  it('serves INTERNAL_ERROR for an ApiError code missing from the catalog', async () => {
    app = buildApp(TEST_APP_CONFIG);
    app.get('/unknown-code', async () => {
      throw new ApiError(422, 'INVALID_PAYLOAD', 'bad data', { field: 'x' });
    });
    const res = await app.inject({ method: 'GET', url: '/unknown-code' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });

  it('ignores a client-supplied X-Correlation-Id', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent',
      headers: { [CORRELATION_ID_HEADER]: 'REQ-deadbeefdeadbeefdeadbeefdeadbeef' },
    });
    const reference = res.json().error.reference;
    expect(reference).not.toBe('REQ-deadbeefdeadbeefdeadbeefdeadbeef');
    expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toBe(reference);
  });

  it('assigns distinct references to concurrent requests', async () => {
    app = buildApp(TEST_APP_CONFIG);
    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: '/nonexistent' }),
      app.inject({ method: 'GET', url: '/nonexistent' }),
    ]);
    expect(a.json().error.reference).not.toBe(b.json().error.reference);
  });

  it('does not send a second body when headers were already sent', async () => {
    app = buildApp(TEST_APP_CONFIG);
    await app.ready();
    const errorLog = vi.fn();
    const request = {
      id: 'REQ-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      method: 'GET',
      url: '/after-headers',
      log: { error: errorLog, warn: vi.fn() },
    };
    const reply = {
      sent: true,
      raw: { headersSent: true, writableEnded: false },
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    await app.errorHandler(new Error('late failure'), request, reply);
    expect(reply.send).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: 'REQ-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      expect.stringContaining('error after headers sent'),
    );
  });

  it('populates request context correlation id during a handler', async () => {
    app = buildApp(TEST_APP_CONFIG);
    let seen;
    app.get('/ctx', async (request) => {
      seen = getCorrelationId();
      return { id: request.id };
    });
    const res = await app.inject({ method: 'GET', url: '/ctx' });
    expect(res.statusCode).toBe(200);
    expect(seen).toBe(res.json().id);
  });
});
