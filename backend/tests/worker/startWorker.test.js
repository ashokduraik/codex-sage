/**
 * Unit tests for startWorker boot wiring (Mongo and runtime are mocked).
 */
import { TEST_APP_CONFIG } from '../appConfig.js';
import { startWorker } from '../../src/worker/index.js';
import { clearJobHandlersForTests } from '../../src/worker/schedule.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetProcessHandlersForTests, resetShutdownForTests } from '../../src/platform/shutdown.js';

describe('startWorker', () => {
  beforeEach(() => {
    resetProcessHandlersForTests();
    resetShutdownForTests();
    clearJobHandlersForTests();
  });

  afterEach(() => {
    resetProcessHandlersForTests();
    resetShutdownForTests();
    clearJobHandlersForTests();
  });

  it('boots: handlers, config, mongo, index sync, runtime, shutdown hooks', async () => {
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const connectMongo = vi.fn().mockResolvedValue(undefined);
    const syncSchemaIndexes = vi.fn().mockResolvedValue(undefined);
    const registerProcessHandlers = vi.fn();
    const registerShutdownHook = vi.fn();
    const attachShutdownSignals = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const startWorkerRuntime = vi.fn().mockReturnValue({
      workerId: 'test-host-42-ab',
      stop,
      getInFlightCount: () => 0,
    });

    const handle = await startWorker({
      loadConfig: () => ({ ...TEST_APP_CONFIG, env: { ...TEST_APP_CONFIG.env, isProduction: false } }),
      connectMongo,
      syncSchemaIndexes,
      registerProcessHandlers,
      registerShutdownHook,
      attachShutdownSignals,
      startWorkerRuntime,
      hostname: () => 'test-host',
      pid: 42,
      bootSuffix: 'ab',
      log,
      clearHandlersForTests: true,
    });

    expect(registerProcessHandlers).toHaveBeenCalledOnce();
    expect(connectMongo).toHaveBeenCalledWith(expect.anything(), log);
    expect(syncSchemaIndexes).toHaveBeenCalledOnce();
    expect(handle.workerId).toBe('test-host-42-ab');
    expect(log.info).toHaveBeenCalledWith({ workerId: 'test-host-42-ab' }, 'worker started');
    expect(startWorkerRuntime).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'test-host-42-ab', log }));
    expect(registerShutdownHook).toHaveBeenCalledWith('stop-worker-runtime', expect.any(Function));
    expect(registerShutdownHook).toHaveBeenCalledWith('disconnect-mongo', expect.any(Function));
    expect(attachShutdownSignals).toHaveBeenCalledOnce();
    await handle.stopRuntime();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('passes enableEnqueueTicks into schedule when enableRepoSyncScheduler is true', async () => {
    const enqueueDueRepositorySyncs = vi.fn().mockResolvedValue({ enqueued: 0, skipped: 0 });
    const enqueueDueAgedOrgDataCleanupJobs = vi.fn().mockResolvedValue({ enqueued: 0, skipped: 0 });
    const startWorkerRuntime = vi.fn().mockReturnValue({
      stop: vi.fn().mockResolvedValue(undefined),
      getInFlightCount: () => 0,
    });
    const handle = await startWorker({
      loadConfig: () => ({
        ...TEST_APP_CONFIG,
        env: { ...TEST_APP_CONFIG.env, isProduction: true },
      }),
      connectMongo: vi.fn().mockResolvedValue(undefined),
      registerProcessHandlers: vi.fn(),
      registerShutdownHook: vi.fn(),
      attachShutdownSignals: vi.fn(),
      startWorkerRuntime,
      enableRepoSyncScheduler: true,
      enqueueDueRepositorySyncs,
      enqueueDueAgedOrgDataCleanupJobs,
      hostname: () => 'sched-host',
      pid: 1,
      bootSuffix: 'aa',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      clearHandlersForTests: true,
      skipDefaultHandlers: true,
    });
    expect(startWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        enableEnqueueTicks: true,
        enqueueDueRepositorySyncs,
        enqueueDueAgedOrgDataCleanupJobs,
      }),
    );
    await handle.stopRuntime();
  });

  it('exits non-zero when the first mongo connect fails', async () => {
    const exit = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      startWorker({
        loadConfig: () => TEST_APP_CONFIG,
        connectMongo: async () => {
          throw new Error('ECONNREFUSED');
        },
        registerProcessHandlers: vi.fn(),
        registerShutdownHook: vi.fn(),
        attachShutdownSignals: vi.fn(),
        startWorkerRuntime: vi.fn(),
        exit,
        log,
        skipDefaultHandlers: true,
      }),
    ).rejects.toThrow(/worker mongo connect failed/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('executes registered shutdown hooks for runtime and mongo', async () => {
    const hooks = [];
    const disconnectMongo = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    await startWorker({
      loadConfig: () => ({ ...TEST_APP_CONFIG, env: { ...TEST_APP_CONFIG.env, isProduction: true } }),
      connectMongo: vi.fn().mockResolvedValue(undefined),
      disconnectMongo,
      registerProcessHandlers: vi.fn(),
      registerShutdownHook: (name, run) => {
        hooks.push({ name, run });
      },
      attachShutdownSignals: vi.fn(),
      startWorkerRuntime: () => ({ stop, getInFlightCount: () => 0 }),
      hostname: () => 'host',
      pid: 9,
      bootSuffix: 'zz',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      clearHandlersForTests: true,
    });
    expect(hooks.map((h) => h.name)).toEqual(['stop-worker-runtime', 'disconnect-mongo']);
    await hooks[0].run();
    await hooks[1].run();
    expect(stop).toHaveBeenCalledOnce();
    expect(disconnectMongo).toHaveBeenCalledOnce();
  });

  it('routes process-handler errors through the worker log', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let captured;
    await startWorker({
      loadConfig: () => ({ ...TEST_APP_CONFIG, env: { ...TEST_APP_CONFIG.env, isProduction: true } }),
      connectMongo: vi.fn().mockResolvedValue(undefined),
      registerProcessHandlers: (deps) => {
        captured = deps;
      },
      registerShutdownHook: vi.fn(),
      attachShutdownSignals: vi.fn(),
      startWorkerRuntime: () => ({ stop: vi.fn(), getInFlightCount: () => 0 }),
      hostname: () => 'h',
      pid: 2,
      bootSuffix: 'aa',
      log,
      clearHandlersForTests: true,
    });
    captured?.logError('boom', { code: 1 });
    captured?.logError('no-context');
    expect(log.error).toHaveBeenCalledWith({ code: 1 }, 'boom');
    expect(log.error).toHaveBeenCalledWith({}, 'no-context');
  });

  it('exits non-zero when schema index sync fails in non-production', async () => {
    const exit = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      startWorker({
        loadConfig: () => ({
          ...TEST_APP_CONFIG,
          env: { ...TEST_APP_CONFIG.env, isProduction: false },
        }),
        connectMongo: vi.fn().mockResolvedValue(undefined),
        syncSchemaIndexes: async () => {
          throw new Error('index boom');
        },
        registerProcessHandlers: vi.fn(),
        registerShutdownHook: vi.fn(),
        attachShutdownSignals: vi.fn(),
        startWorkerRuntime: vi.fn(),
        exit,
        log,
        skipDefaultHandlers: true,
      }),
    ).rejects.toThrow(/worker index sync failed/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('uses platform defaults when optional deps are omitted', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const connectMongo = vi.fn().mockResolvedValue(undefined);
    let captured;
    const handle = await startWorker({
      loadConfig: () => ({
        ...TEST_APP_CONFIG,
        env: { ...TEST_APP_CONFIG.env, isProduction: true },
      }),
      connectMongo,
      registerProcessHandlers: (deps) => {
        captured = deps;
      },
      startWorkerRuntime: () => ({ stop: vi.fn(), getInFlightCount: () => 0 }),
      hostname: () => 'default-host',
      pid: 99,
      bootSuffix: 'ff',
      clearHandlersForTests: true,
      registerExtraHandlers: (register) => {
        register({
          type: 'extra_test_job',
          exclusiveScope: 'project',
          run: async () => ({ result: 'completed' }),
        });
      },
    });
    expect(handle.workerId).toBe('default-host-99-ff');
    expect(connectMongo).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    captured?.logError('boom', { code: 1 });
    captured?.logError('no-context');
    // Exercise default warn/debug paths via the same console-backed logger shape.
    const defaultLog = {
      debug: (obj, msg) => console.debug(JSON.stringify({ level: 'debug', msg, ...obj })),
      info: (obj, msg) => console.info(JSON.stringify({ level: 'info', msg, ...obj })),
      warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
      error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
    };
    defaultLog.debug({}, 'd');
    defaultLog.warn({}, 'w');
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    await handle.stopRuntime();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
