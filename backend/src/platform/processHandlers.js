/**
 * Process-level safety nets for unhandled promise rejections and sync exceptions.
 *
 * These are not a substitute for correct request/stream error handling — they stop
 * stray rejections from taking down the Node process under Node's default
 * fatal-unhandledRejection behavior.
 */
let registered = false;
/**
 * Registers `unhandledRejection` and `uncaughtException` handlers once per process.
 *
 * - `unhandledRejection`: log and keep the process alive.
 * - `uncaughtException`: log then exit(1) — sync state may be corrupt.
 *
 * @param deps - Logger and optional process/exit overrides for tests.
 */
export function registerProcessHandlers(deps) {
    if (registered) {
        return;
    }
    registered = true;
    const proc = deps.proc ?? process;
    const exitFn = deps.exit ?? ((code) => process.exit(code));
    proc.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error
            ? { message: reason.message, name: reason.name, stack: reason.stack }
            : { reason: String(reason) };
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
    registered = false;
}
