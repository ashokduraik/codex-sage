import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  attachShutdownSignals,
  registerShutdownHook,
  resetShutdownForTests,
  runShutdown,
  SHUTDOWN_TIMEOUT_MS,
} from './shutdown';

describe('shutdown', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    resetShutdownForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetShutdownForTests();
  });

  it('runs hooks in reverse registration order', async () => {
    const order: string[] = [];
    registerShutdownHook('first', async () => {
      order.push('first');
    });
    registerShutdownHook('second', async () => {
      order.push('second');
    });

    const exit = vi.fn() as unknown as (code: number) => never;
    await runShutdown('SIGTERM', { log, exit });

    expect(order).toEqual(['second', 'first']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reports a failing hook, still runs remaining hooks, and exits non-zero', async () => {
    const order: string[] = [];
    registerShutdownHook('keep-going', async () => {
      order.push('keep-going');
    });
    registerShutdownHook('boom', async () => {
      order.push('boom');
      throw new Error('hook exploded');
    });

    const exit = vi.fn() as unknown as (code: number) => never;
    await runShutdown('SIGTERM', { log, exit });

    expect(order).toEqual(['boom', 'keep-going']);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ hook: 'boom' }),
      'shutdown hook failed',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('enforces SHUTDOWN_TIMEOUT_MS per hook', async () => {
    registerShutdownHook('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const exit = vi.fn() as unknown as (code: number) => never;
    await runShutdown('SIGTERM', { log, exit, timeoutMs: 5 });

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hook: 'slow',
        errMessage: expect.stringContaining('timed out'),
      }),
      'shutdown hook failed',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it('forces an immediate exit on a second signal during shutdown', async () => {
    let releaseSlow: (() => void) | undefined;
    registerShutdownHook('slow', async () => {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
    });

    const exit = vi.fn() as unknown as (code: number) => never;
    const first = runShutdown('SIGTERM', { log, exit });
    await Promise.resolve();
    await runShutdown('SIGINT', { log, exit });

    expect(log.warn).toHaveBeenCalledWith(
      { signal: 'SIGINT' },
      'second shutdown signal — forcing exit',
    );
    expect(exit).toHaveBeenCalledWith(1);

    releaseSlow?.();
    await first;
  });

  it('attachShutdownSignals wires SIGTERM and SIGINT once', () => {
    const on = vi.fn();
    const proc = { on } as unknown as NodeJS.Process;
    const exit = vi.fn() as unknown as (code: number) => never;

    attachShutdownSignals({ log, exit, proc });
    attachShutdownSignals({ log, exit, proc });

    expect(on).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('signal handlers invoke runShutdown', async () => {
    const listeners = new Map<string, (signal: NodeJS.Signals) => void>();
    const proc = {
      on: (event: string, handler: (signal: NodeJS.Signals) => void) => {
        listeners.set(event, handler);
      },
    } as unknown as NodeJS.Process;
    const exit = vi.fn() as unknown as (code: number) => never;
    const order: string[] = [];
    registerShutdownHook('only', async () => {
      order.push('only');
    });

    attachShutdownSignals({ log, exit, proc });
    listeners.get('SIGTERM')?.('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(['only']);
  });
});
