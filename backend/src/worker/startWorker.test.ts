import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_APP_CONFIG } from '../test/appConfig';
import { resetProcessHandlersForTests } from '../platform/processHandlers';
import { resetShutdownForTests } from '../platform/shutdown';
import { startWorker, WORKER_HEARTBEAT_INTERVAL_MS } from './startWorker';

describe('startWorker', () => {
  beforeEach(() => {
    resetProcessHandlersForTests();
    resetShutdownForTests();
  });

  afterEach(() => {
    resetProcessHandlersForTests();
    resetShutdownForTests();
  });

  it('boots: handlers, config, mongo, heartbeat, shutdown hooks', async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const connectMongo = vi.fn().mockResolvedValue(undefined);
    const registerProcessHandlers = vi.fn();
    const registerShutdownHook = vi.fn();
    const attachShutdownSignals = vi.fn();
    const setIntervalFn = vi.fn().mockReturnValue(123 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const handle = await startWorker({
      loadConfig: () => TEST_APP_CONFIG,
      connectMongo,
      registerProcessHandlers,
      registerShutdownHook,
      attachShutdownSignals,
      setInterval: setIntervalFn as unknown as typeof setInterval,
      clearInterval: clearIntervalFn,
      hostname: () => 'test-host',
      pid: 42,
      log,
    });

    expect(registerProcessHandlers).toHaveBeenCalledOnce();
    expect(connectMongo).toHaveBeenCalledWith(TEST_APP_CONFIG, log);
    expect(handle.workerId).toBe('test-host:42');
    expect(log.info).toHaveBeenCalledWith({ workerId: 'test-host:42' }, 'worker started');
    expect(setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      WORKER_HEARTBEAT_INTERVAL_MS,
    );
    expect(registerShutdownHook).toHaveBeenCalledWith(
      'clear-heartbeat',
      expect.any(Function),
    );
    expect(registerShutdownHook).toHaveBeenCalledWith(
      'disconnect-mongo',
      expect.any(Function),
    );
    expect(attachShutdownSignals).toHaveBeenCalledOnce();

    handle.stopHeartbeat();
    expect(clearIntervalFn).toHaveBeenCalledWith(123);
  });

  it('exits non-zero when the first mongo connect fails', async () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      startWorker({
        loadConfig: () => TEST_APP_CONFIG,
        connectMongo: async () => {
          throw new Error('ECONNREFUSED');
        },
        registerProcessHandlers: vi.fn(),
        registerShutdownHook: vi.fn(),
        attachShutdownSignals: vi.fn(),
        setInterval: vi.fn() as unknown as typeof setInterval,
        clearInterval: vi.fn(),
        exit,
        log,
      }),
    ).rejects.toThrow(/worker mongo connect failed/);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('runs the heartbeat callback with a debug-style info log', async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let heartbeatFn: (() => void) | undefined;
    const setIntervalFn = vi.fn((fn: () => void) => {
      heartbeatFn = fn;
      return 1 as unknown as NodeJS.Timeout;
    });

    await startWorker({
      loadConfig: () => TEST_APP_CONFIG,
      connectMongo: vi.fn().mockResolvedValue(undefined),
      registerProcessHandlers: vi.fn(),
      registerShutdownHook: vi.fn(),
      attachShutdownSignals: vi.fn(),
      setInterval: setIntervalFn as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      hostname: () => 'h',
      pid: 1,
      log,
    });

    heartbeatFn?.();
    expect(log.info).toHaveBeenCalledWith({ workerId: 'h:1' }, 'worker heartbeat');
  });

  it('executes registered shutdown hooks for heartbeat and mongo', async () => {
    const hooks: Array<{ name: string; run: () => Promise<void> }> = [];
    const clearIntervalFn = vi.fn();
    const disconnectMongo = vi.fn().mockResolvedValue(undefined);
    const timer = Object.assign(7, { unref: vi.fn() });

    await startWorker({
      loadConfig: () => TEST_APP_CONFIG,
      connectMongo: vi.fn().mockResolvedValue(undefined),
      disconnectMongo,
      registerProcessHandlers: vi.fn(),
      registerShutdownHook: (name, run) => {
        hooks.push({ name, run });
      },
      attachShutdownSignals: vi.fn(),
      setInterval: vi.fn().mockReturnValue(timer) as unknown as typeof setInterval,
      clearInterval: clearIntervalFn,
      hostname: () => 'host',
      pid: 9,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(timer.unref).toHaveBeenCalledOnce();
    expect(hooks.map((h) => h.name)).toEqual(['clear-heartbeat', 'disconnect-mongo']);
    await hooks[0]!.run();
    await hooks[1]!.run();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    expect(disconnectMongo).toHaveBeenCalledOnce();
  });

  it('routes process-handler errors through the worker log', async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let captured:
      | {
          logError: (message: string, context?: Record<string, unknown>) => void;
        }
      | undefined;

    await startWorker({
      loadConfig: () => TEST_APP_CONFIG,
      connectMongo: vi.fn().mockResolvedValue(undefined),
      registerProcessHandlers: (deps) => {
        captured = deps;
      },
      registerShutdownHook: vi.fn(),
      attachShutdownSignals: vi.fn(),
      setInterval: vi.fn().mockReturnValue(1) as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      hostname: () => 'h',
      pid: 2,
      log,
    });

    captured?.logError('boom', { code: 1 });
    captured?.logError('no-context');
    expect(log.error).toHaveBeenCalledWith({ code: 1 }, 'boom');
    expect(log.error).toHaveBeenCalledWith({}, 'no-context');
  });

  it('uses platform defaults when optional deps are omitted', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const connectMongo = vi.fn().mockResolvedValue(undefined);
    const setIntervalFn = vi
      .fn()
      .mockReturnValue(1 as unknown as NodeJS.Timeout);

    const handle = await startWorker({
      loadConfig: () => TEST_APP_CONFIG,
      connectMongo,
      setInterval: setIntervalFn as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      hostname: () => 'default-host',
      pid: 99,
    });

    expect(handle.workerId).toBe('default-host:99');
    expect(connectMongo).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    handle.stopHeartbeat();
    infoSpy.mockRestore();
  });
});
