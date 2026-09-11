import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerProcessHandlers,
  resetProcessHandlersForTests,
} from './processHandlers';

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
    const proc = { on } as unknown as NodeJS.Process;

    registerProcessHandlers({ logError, proc, exit: vi.fn() as never });
    registerProcessHandlers({ logError, proc, exit: vi.fn() as never });

    expect(on).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
  });

  it('keeps the process alive on unhandledRejection', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    });
    const logError = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;

    registerProcessHandlers({
      logError,
      proc: { on } as unknown as NodeJS.Process,
      exit,
    });

    handlers.get('unhandledRejection')?.(new Error('terminated'));
    expect(logError).toHaveBeenCalledWith(
      'unhandledRejection — process kept alive',
      expect.objectContaining({ err: expect.objectContaining({ message: 'terminated' }) }),
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('stringifies non-Error unhandledRejection reasons', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    });
    const logError = vi.fn();

    registerProcessHandlers({
      logError,
      proc: { on } as unknown as NodeJS.Process,
      exit: vi.fn() as never,
    });

    handlers.get('unhandledRejection')?.('plain-string');
    expect(logError).toHaveBeenCalledWith(
      'unhandledRejection — process kept alive',
      expect.objectContaining({ err: { reason: 'plain-string' } }),
    );
  });

  it('exits on uncaughtException after logging', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    });
    const logError = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;

    registerProcessHandlers({
      logError,
      proc: { on } as unknown as NodeJS.Process,
      exit,
    });

    handlers.get('uncaughtException')?.(new Error('fatal'));
    expect(logError).toHaveBeenCalledWith(
      'uncaughtException — exiting',
      expect.objectContaining({ err: expect.objectContaining({ message: 'fatal' }) }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
