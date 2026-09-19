import type { AuditLogEntry, AuditLogStore } from "./store/types.js";
import { logger } from "./logger.js";

/**
 * Records an audit-log entry without ever throwing. The mutation this
 * accompanies has already succeeded (and, for an HTTP route, its response
 * is already about to be sent) — a transient failure to persist the audit
 * trail must never hang the request or crash the process (Express 4
 * doesn't forward a rejection thrown after the response starts to error
 * middleware on its own).
 */
export async function recordAudit(
  auditLogStore: AuditLogStore,
  entry: Omit<AuditLogEntry, "id" | "createdAt">
): Promise<void> {
  try {
    await auditLogStore.record(entry);
  } catch (err) {
    logger.error("audit_log_write_failed", {
      action: entry.action,
      tenantId: entry.tenantId,
      error: (err as Error).message,
    });
  }
}
