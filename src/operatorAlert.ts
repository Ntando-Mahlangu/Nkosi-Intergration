import { postToUntrustedUrl } from "./ssrf.js";
import { logger } from "./logger.js";

/**
 * Best-effort operator-facing alert for system-health events this process
 * can't route to any tenant (a process about to crash, a worker tick that
 * failed outright, a notification exhausting all its retries) — as opposed
 * to notify.ts, which alerts a *tenant's* team about a lead's reply.
 *
 * Delivered via the same postToUntrustedUrl (src/ssrf.ts) notify.ts uses —
 * mainly for its DNS-pinning/no-redirect delivery behavior, not because
 * OPERATOR_ALERT_WEBHOOK_URL is untrusted (it's operator-configured, not
 * user input). One consequence: like any target that function delivers to,
 * it must resolve to a public address — pointing this at an internal/
 * private alerting endpoint (e.g. a self-hosted receiver on a private
 * network) isn't supported.
 *
 * No-ops silently when OPERATOR_ALERT_WEBHOOK_URL isn't set — this is an
 * optional capability, not a requirement (see DEPLOYMENT.md "Alerting").
 * Never throws: this is called from places (fatalErrorHandlers, the worker's
 * catch-alls) where an alerting failure must never become a second failure.
 */
export async function sendOperatorAlert(message: string, details?: Record<string, unknown>): Promise<void> {
  const url = process.env.OPERATOR_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    // `text` makes this work directly as a Slack (or similar) incoming
    // webhook, matching the same convention notify.ts's payload uses.
    const payload = { text: message, ...details };
    const result = await postToUntrustedUrl(url, JSON.stringify(payload), 5_000);
    if (!result.ok) {
      logger.warn("operator_alert_delivery_failed", { message, status: result.status });
    }
  } catch (err) {
    logger.warn("operator_alert_delivery_failed", { message, error: (err as Error).message });
  }
}
