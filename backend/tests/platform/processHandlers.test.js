import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerProcessHandlers, resetProcessHandlersForTests, } from '../../src/platform/shutdown.js';
describe('registerProcessHandlers', () => {
    beforeEach(() => {
        resetProcessHandlersForTests();
    });
    afterEach(() => {
        resetProcessHandlersForTests();
    });
    it('registers unhandledRejection and uncaughtException once', () => {
        const on = vi.fn();
        const logError = vi.fn();
        const proc = { on };
        registerProcessHandlers({ logError, proc, exit: vi.fn() });
        registerProcessHandlers({ logError, proc, exit: vi.fn() });
        expect(on).toHaveBeenCalledTimes(2);
        expect(on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
        expect(on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    });
    it('keeps the process alive on unhandledRejection', () => {
        const handlers = new Map();
        const on = vi.fn((event, handler) => {
            handlers.set(event, handler);
        });
        const logError = vi.fn();
        const exit = vi.fn();
        registerProcessHandlers({
            logError,
            proc: { on },
            exit,
        });
        handlers.get('unhandledRejection')?.(new Error('terminated'));
        expect(logError).toHaveBeenCalledWith('unhandledRejection — process kept alive', expect.objectContaining({ err: expect.objectContaining({ message: 'terminated' }) }));
        expect(exit).not.toHaveBeenCalled();
    });
    it('stringifies non-Error unhandledRejection reasons', () => {
        const handlers = new Map();
        const on = vi.fn((event, handler) => {
            handlers.set(event, handler);
        });
        const logError = vi.fn();
        registerProcessHandlers({
            logError,
            proc: { on },
            exit: vi.fn(),
        });
        handlers.get('unhandledRejection')?.('plain-string');
        expect(logError).toHaveBeenCalledWith('unhandledRejection — process kept alive', expect.objectContaining({ err: { reason: 'plain-string' } }));
    });
    it('exits on uncaughtException after logging', () => {
        const handlers = new Map();
        const on = vi.fn((event, handler) => {
            handlers.set(event, handler);
        });
        const logError = vi.fn();
        const exit = vi.fn();
        registerProcessHandlers({
            logError,
            proc: { on },
            exit,
        });
        handlers.get('uncaughtException')?.(new Error('fatal'));
        expect(logError).toHaveBeenCalledWith('uncaughtException — exiting', expect.objectContaining({ err: expect.objectContaining({ message: 'fatal' }) }));
        expect(exit).toHaveBeenCalledWith(1);
    });
});
