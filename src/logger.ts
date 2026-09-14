/**
 * Structured JSON logging for the long-running server/worker processes, so
 * output is trivial to ingest into any log aggregator (CloudWatch, Loki,
 * Datadog, ...) instead of being free-form text. Deliberately not used by
 * the interactive CLI scripts (src/cli.ts, src/scripts/*) — those print
 * human-facing terminal output, which JSON would only make worse.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...context });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
