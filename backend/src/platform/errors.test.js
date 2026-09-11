import { describe, it, expect, afterEach } from 'vitest';
import { ApiError, canSendJsonError } from './errors.js';
import { buildApp } from '../http/app.js';
import { TEST_APP_CONFIG } from '../test/appConfig.js';
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
        expect(canSendJsonError({
            sent: true,
            raw: { headersSent: false, writableEnded: false },
        })).toBe(false);
        expect(canSendJsonError({
            sent: false,
            raw: { headersSent: false, writableEnded: true },
        })).toBe(false);
    });
    it('returns true when a JSON body can still be written', () => {
        expect(canSendJsonError({
            sent: false,
            raw: { headersSent: false, writableEnded: false },
        })).toBe(true);
    });
});
describe('registerErrorHandler (integration via buildApp)', () => {
    let app;
    afterEach(async () => {
        await app?.close();
        app = undefined;
    });
    it('returns 404 NOT_FOUND for unknown routes', async () => {
        app = buildApp(TEST_APP_CONFIG);
        const res = await app.inject({ method: 'GET', url: '/nonexistent' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });
    it('returns 500 INTERNAL_ERROR for unhandled generic errors', async () => {
        app = buildApp(TEST_APP_CONFIG);
        app.get('/boom', async () => {
            throw new Error('something broke');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toMatchObject({
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
        expect(res.json().error.message).not.toBe('something broke');
    });
    it('preserves ApiError statusCode, code, message, and details', async () => {
        app = buildApp(TEST_APP_CONFIG);
        app.get('/custom', async () => {
            throw new ApiError(422, 'INVALID_PAYLOAD', 'bad data', { field: 'x' });
        });
        const res = await app.inject({ method: 'GET', url: '/custom' });
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({
            error: { code: 'INVALID_PAYLOAD', message: 'bad data', details: { field: 'x' } },
        });
    });
    it('returns REQUEST_ERROR code for non-ApiError 4xx errors', async () => {
        app = buildApp(TEST_APP_CONFIG);
        app.get('/badreq', async () => {
            const err = Object.assign(new Error('bad request'), { statusCode: 400 });
            throw err;
        });
        const res = await app.inject({ method: 'GET', url: '/badreq' });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: { code: 'REQUEST_ERROR' } });
    });
});
