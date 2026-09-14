import { logger } from "./logger.js";

/**
 * Last-resort safety net for the server/worker processes: something that
 * slipped past every specific try/catch already in place (this codebase's
 * own review found several bugs shaped exactly like this — a `void fn()`
 * call whose fn rejected, an awaited call with no local handling). Without
 * this, an uncaught exception or unhandled rejection crashes the process
 * with Node's default unstructured stderr dump, invisible to whatever's
 * tailing the structured JSON log stream (see logger.ts) for alerting.
 *
 * Logs via the structured logger, then exits deliberately — Node's own
 * guidance is that continuing after an uncaught exception risks running
 * with corrupted state; let the process manager (systemd, Docker, an
 * orchestrator) restart it instead of limping on.
 *
 * Call this only from an actual process entrypoint, never from a module
 * that might be imported by tests — installing process-wide handlers
 * during `vitest run` would interfere with vitest's own error reporting.
 *
 * A real deployment should also wire an APM/error-tracking service (Sentry
 * or similar) into these two handlers; this repo doesn't hardwire one in
 * since that needs a real account/DSN, but the hook point is here — see
 * DEPLOYMENT.md.
 */
export function installFatalErrorHandlers(processName: string): void {
  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", { process: processName, error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("unhandled_rejection", { process: processName, error: error.message, stack: error.stack });
    process.exit(1);
  });
}
