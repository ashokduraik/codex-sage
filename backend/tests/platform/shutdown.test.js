import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachShutdownSignals, registerShutdownHook, resetShutdownForTests, runShutdown, SHUTDOWN_TIMEOUT_MS } from '../../src/platform/shutdown.js';
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
    const order = [];
    registerShutdownHook('first', async () => {
      order.push('first');
    });
    registerShutdownHook('second', async () => {
      order.push('second');
    });
    const exit = vi.fn();
    await runShutdown('SIGTERM', { log, exit });
    expect(order).toEqual(['second', 'first']);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it('reports a failing hook, still runs remaining hooks, and exits non-zero', async () => {
    const order = [];
    registerShutdownHook('keep-going', async () => {
      order.push('keep-going');
    });
    registerShutdownHook('boom', async () => {
      order.push('boom');
      throw new Error('hook exploded');
    });
    const exit = vi.fn();
    await runShutdown('SIGTERM', { log, exit });
    expect(order).toEqual(['boom', 'keep-going']);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ hook: 'boom' }), 'shutdown hook failed');
    expect(exit).toHaveBeenCalledWith(1);
  });
  it('enforces SHUTDOWN_TIMEOUT_MS per hook', async () => {
    registerShutdownHook('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const exit = vi.fn();
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
    let releaseSlow;
    registerShutdownHook('slow', async () => {
      await new Promise((resolve) => {
        releaseSlow = resolve;
      });
    });
    const exit = vi.fn();
    const first = runShutdown('SIGTERM', { log, exit });
    await Promise.resolve();
    await runShutdown('SIGINT', { log, exit });
    expect(log.warn).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'second shutdown signal — forcing exit');
    expect(exit).toHaveBeenCalledWith(1);
    releaseSlow?.();
    await first;
  });
  it('attachShutdownSignals wires SIGTERM and SIGINT once', () => {
    const on = vi.fn();
    const proc = { on };
    const exit = vi.fn();
    attachShutdownSignals({ log, exit, proc });
    attachShutdownSignals({ log, exit, proc });
    expect(on).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
  it('signal handlers invoke runShutdown', async () => {
    const listeners = new Map();
    const proc = {
      on: (event, handler) => {
        listeners.set(event, handler);
      },
    };
    const exit = vi.fn();
    const order = [];
    registerShutdownHook('only', async () => {
      order.push('only');
    });
    attachShutdownSignals({ log, exit, proc });
    listeners.get('SIGTERM')?.('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(['only']);
  });
});
