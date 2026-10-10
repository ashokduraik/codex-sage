/**
 * Ordered graceful-shutdown hook registry for API and worker entrypoints.
 */
/** Per-hook shutdown budget. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
const hooks = [];
let shuttingDown = false;
let signalHandlersAttached = false;
/**
 * Registers a shutdown hook. Later phases add worker-loop stop, SSE drain, etc.
 * Hooks run in reverse registration order during {@link runShutdown}.
 * @param name - Stable name for logs.
 * @param run - Async cleanup function.
 */
export function registerShutdownHook(name, run) {
  hooks.push({ name, run });
}
/**
 * Clears registered hooks and in-progress flag. For unit tests only.
 */
export function resetShutdownForTests() {
  hooks.length = 0;
  shuttingDown = false;
  signalHandlersAttached = false;
}
/**
 * Runs hooks in reverse registration order, then exits.
 * A second signal while shutdown is in progress forces an immediate exit(1).
 * @param signal - Signal name for logs (`SIGTERM`, `SIGINT`, …).
 * @param deps - Logger and injectable exit/process.
 */
export async function runShutdown(signal, deps) {
  const exitFn = deps.exit ?? ((code) => process.exit(code));
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  if (shuttingDown) {
    deps.log.warn({ signal }, 'second shutdown signal — forcing exit');
    exitFn(1);
    return;
  }
  shuttingDown = true;
  deps.log.info({ signal }, 'shutdown started');
  let failed = false;
  for (const hook of [...hooks].reverse()) {
    try {
      await runHookWithTimeout(hook, timeoutMs);
      deps.log.info({ hook: hook.name }, 'shutdown hook completed');
    } catch (err) {
      failed = true;
      const errMessage = err instanceof Error ? err.message : String(err);
      deps.log.error({ hook: hook.name, errMessage }, 'shutdown hook failed');
    }
  }
  exitFn(failed ? 1 : 0);

  /**
   * Runs a single hook with a timeout budget.
   * @param hook - Hook to run.
   * @param timeoutMs - Budget in milliseconds.
   */
  async function runHookWithTimeout(hook, timeoutMs) {
    let timer;
    try {
      await Promise.race([
        hook.run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`shutdown hook timed out: ${hook.name}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
/**
 * Attaches SIGTERM/SIGINT handlers that invoke {@link runShutdown}.
 * @param deps - Logger and injectable exit/process.
 */
export function attachShutdownSignals(deps) {
  if (signalHandlersAttached) {
    return;
  }
  signalHandlersAttached = true;
  const proc = deps.proc ?? process;
  const onSignal = (signal) => {
    void runShutdown(signal, deps);
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);
}

let processHandlersRegistered = false;

/**
 * Registers `unhandledRejection` and `uncaughtException` handlers once per process.
 *
 * - `unhandledRejection`: log and keep the process alive.
 * - `uncaughtException`: log then exit(1) — sync state may be corrupt.
 *
 * @param deps - Logger and optional process/exit overrides for tests.
 */
export function registerProcessHandlers(deps) {
  if (processHandlersRegistered) {
    return;
  }
  processHandlersRegistered = true;
  const proc = deps.proc ?? process;
  const exitFn = deps.exit ?? ((code) => process.exit(code));
  proc.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? { message: reason.message, name: reason.name, stack: reason.stack } : { reason: String(reason) };
    deps.logError('unhandledRejection — process kept alive', { err });
  });
  proc.on('uncaughtException', (error) => {
    deps.logError('uncaughtException — exiting', {
      err: { message: error.message, name: error.name, stack: error.stack },
    });
    exitFn(1);
  });
}

/**
 * Resets the one-shot registration guard. For unit tests only.
 */
export function resetProcessHandlersForTests() {
  processHandlersRegistered = false;
}
