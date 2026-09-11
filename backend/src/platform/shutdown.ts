/**
 * Ordered graceful-shutdown hook registry for API and worker entrypoints.
 */

/** Per-hook shutdown budget. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** A named async cleanup step registered before listen/idle. */
export interface ShutdownHook {
  name: string;
  run: () => Promise<void>;
}

/** Injectable process/exit seams for tests. */
export interface ShutdownDeps {
  /** Log structured shutdown progress. */
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
  /** Exit the process (injected for tests). */
  exit?: (code: number) => never;
  /** Process to attach signal listeners to. */
  proc?: NodeJS.Process;
  /** Override per-hook timeout (tests only). */
  timeoutMs?: number;
}

const hooks: ShutdownHook[] = [];
let shuttingDown = false;
let signalHandlersAttached = false;

/**
 * Registers a shutdown hook. Later phases add worker-loop stop, SSE drain, etc.
 * Hooks run in reverse registration order during {@link runShutdown}.
 * @param name - Stable name for logs.
 * @param run - Async cleanup function.
 */
export function registerShutdownHook(name: string, run: () => Promise<void>): void {
  hooks.push({ name, run });
}

/**
 * Clears registered hooks and in-progress flag. For unit tests only.
 */
export function resetShutdownForTests(): void {
  hooks.length = 0;
  shuttingDown = false;
  signalHandlersAttached = false;
}

/**
 * Runs a single hook with a timeout budget.
 * @param hook - Hook to run.
 * @param timeoutMs - Budget in milliseconds.
 */
async function runHookWithTimeout(hook: ShutdownHook, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hook.run(),
      new Promise<never>((_, reject) => {
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

/**
 * Runs hooks in reverse registration order, then exits.
 * A second signal while shutdown is in progress forces an immediate exit(1).
 * @param signal - Signal name for logs (`SIGTERM`, `SIGINT`, …).
 * @param deps - Logger and injectable exit/process.
 */
export async function runShutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  const exitFn = deps.exit ?? ((code: number) => process.exit(code) as never);
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
}

/**
 * Attaches SIGTERM/SIGINT handlers that invoke {@link runShutdown}.
 * @param deps - Logger and injectable exit/process.
 */
export function attachShutdownSignals(deps: ShutdownDeps): void {
  if (signalHandlersAttached) {
    return;
  }
  signalHandlersAttached = true;

  const proc = deps.proc ?? process;
  const onSignal = (signal: NodeJS.Signals): void => {
    void runShutdown(signal, deps);
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);
}
