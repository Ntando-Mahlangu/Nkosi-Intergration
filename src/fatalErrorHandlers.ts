import { logger } from "./logger.js";
import { sendOperatorAlert } from "./operatorAlert.js";

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
 * Also fires a best-effort operator alert (src/operatorAlert.ts) — a no-op
 * unless OPERATOR_ALERT_WEBHOOK_URL is configured — bounded by that
 * function's own timeout (DNS + request, so up to roughly twice its
 * `timeoutMs` in the worst case — see src/ssrf.ts's withTimeout) so a
 * slow/broken alert target can delay, but never indefinitely block, the
 * crash-and-restart this function exists to guarantee. A real deployment
 * should still consider wiring an APM/error-tracking service (Sentry or
 * similar) in as well for deeper diagnostics; this repo doesn't hardwire
 * one in since that needs a real account/DSN, but the hook point is here —
 * see DEPLOYMENT.md.
 */
export function installFatalErrorHandlers(processName: string): void {
  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", { process: processName, error: err.message, stack: err.stack });
    void sendOperatorAlert(`Fatal error in ${processName}: ${err.message}`, { process: processName }).finally(() =>
      process.exit(1)
    );
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("unhandled_rejection", { process: processName, error: error.message, stack: error.stack });
    void sendOperatorAlert(`Fatal error in ${processName}: ${error.message}`, { process: processName }).finally(() =>
      process.exit(1)
    );
  });
}
