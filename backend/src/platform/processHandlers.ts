/**
 * Process-level safety nets for unhandled promise rejections and sync exceptions.
 *
 * These are not a substitute for correct request/stream error handling — they stop
 * stray rejections from taking down the Node process under Node's default
 * fatal-unhandledRejection behavior.
 */

export interface ProcessHandlerDeps {
  /** Structured or console error logger. */
  logError: (message: string, context?: Record<string, unknown>) => void;
  /** Exit the process (injected for tests). Defaults to process.exit. */
  exit?: (code: number) => never;
  /** Process instance to attach listeners to (injected for tests). */
  proc?: NodeJS.Process;
}

let registered = false;

/**
 * Registers `unhandledRejection` and `uncaughtException` handlers once per process.
 *
 * - `unhandledRejection`: log and keep the process alive.
 * - `uncaughtException`: log then exit(1) — sync state may be corrupt.
 *
 * @param deps - Logger and optional process/exit overrides for tests.
 */
export function registerProcessHandlers(deps: ProcessHandlerDeps): void {
  if (registered) {
    return;
  }
  registered = true;

  const proc = deps.proc ?? process;
  const exitFn = deps.exit ?? ((code: number) => process.exit(code) as never);

  proc.on('unhandledRejection', (reason: unknown) => {
    const err =
      reason instanceof Error
        ? { message: reason.message, name: reason.name, stack: reason.stack }
        : { reason: String(reason) };
    deps.logError('unhandledRejection — process kept alive', { err });
  });

  proc.on('uncaughtException', (error: Error) => {
    deps.logError('uncaughtException — exiting', {
      err: { message: error.message, name: error.name, stack: error.stack },
    });
    exitFn(1);
  });
}

/**
 * Resets the one-shot registration guard. For unit tests only.
 */
export function resetProcessHandlersForTests(): void {
  registered = false;
}
