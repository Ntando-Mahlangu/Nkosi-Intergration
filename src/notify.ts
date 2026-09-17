import type { Channel, Lead, Tenant } from "./types.js";
import type { NotificationStore } from "./store/types.js";
import { logger } from "./logger.js";
import { postToUntrustedUrl } from "./ssrf.js";

export type NotifyReason = "interested" | "needs_human_reply";

/** Total delivery cycles (the inline attempt below, plus worker-driven redeliveries) before giving up and marking a failure "dead". */
export const NOTIFICATION_MAX_ATTEMPTS = 5;

const SUMMARIES: Record<NotifyReason, (lead: Lead, channel: Channel, body: string) => string> = {
  interested: (lead, channel, body) => `🔥 ${lead.name ?? lead.id} replied "interested" via ${channel}: "${body}"`,
  needs_human_reply: (lead, channel, body) =>
    `🙋 ${lead.name ?? lead.id} needs a human reply via ${channel} (auto-reply couldn't answer): "${body}"`,
};

const EVENT_NAMES: Record<NotifyReason, string> = {
  interested: "lead_interested",
  needs_human_reply: "needs_human_reply",
};

function buildPayload(
  tenant: Tenant,
  lead: Lead,
  channel: Channel,
  body: string,
  reason: NotifyReason
): Record<string, unknown> {
  return {
    text: SUMMARIES[reason](lead, channel, body),
    event: EVENT_NAMES[reason],
    tenantId: tenant.id,
    lead: {
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      requestedService: lead.requestedService,
    },
    channel,
    message: body,
  };
}

/**
 * A single delivery attempt. Never throws — returns the failure reason
 * instead. Uses postToUntrustedUrl (src/ssrf.ts) rather than a plain
 * fetch(): webhookUrl is entirely tenant-controlled and this is a real
 * server-side request triggered by lead/tenant-controlled events (a reply
 * classifying "interested", a chatbot escalation) — postToUntrustedUrl
 * pins the connection to a single validated address so this can't be used
 * as a DNS-rebinding SSRF proxy into an internal network, and never
 * follows a redirect a compromised/malicious target might issue.
 */
export async function deliverNotification(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await postToUntrustedUrl(webhookUrl, JSON.stringify(payload));
    if (result.redirected) {
      return { ok: false, error: "webhook responded with a redirect, which is not followed" };
    }
    if (!result.ok) return { ok: false, error: `webhook responded ${result.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Best-effort notification for the two cases a human should act on
 * promptly: a reply classified "interested", or one the auto-reply
 * chatbot couldn't confidently answer from the knowledge base and
 * escalated. POSTs a JSON body to tenant.notifyWebhookUrl; the `text`
 * field makes it work directly as a Slack (or similar) incoming webhook,
 * while the rest of the payload is there for a custom endpoint to use.
 *
 * Retries once inline after a short delay to absorb a single blip; if that
 * still fails, persists the notification to `notificationStore` (when
 * given) so it isn't silently lost — the worker retries pending ones on
 * every tick (see worker.ts) until NOTIFICATION_MAX_ATTEMPTS is reached.
 * Never throws — a broken notification target must never fail the inbound
 * webhook request that triggered it.
 */
export async function notifyHumanAttention(
  notificationStore: NotificationStore | undefined,
  tenant: Tenant,
  lead: Lead,
  channel: Channel,
  body: string,
  reason: NotifyReason
): Promise<void> {
  if (!tenant.notifyWebhookUrl) return;
  const webhookUrl = tenant.notifyWebhookUrl;
  const payload = buildPayload(tenant, lead, channel, body, reason);

  let result = await deliverNotification(webhookUrl, payload);
  if (!result.ok) {
    logger.warn("notification_delivery_failed", { tenantId: tenant.id, leadId: lead.id, reason, error: result.error });
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await deliverNotification(webhookUrl, payload);
  }

  if (result.ok) return;

  logger.error("notification_delivery_failed_retrying", {
    tenantId: tenant.id,
    leadId: lead.id,
    reason,
    error: result.error,
  });
  if (!notificationStore) return;
  try {
    await notificationStore.recordFailure({
      tenantId: tenant.id,
      leadId: lead.id,
      reason,
      webhookUrl,
      payload,
      error: result.error,
    });
  } catch (err) {
    // Belt-and-braces: this function must never throw (callers use `void
    // notifyHumanAttention(...)` without awaiting, so an unhandled
    // rejection here would crash the process on an otherwise-harmless
    // failure to persist a dead-lettered notification).
    logger.error("notification_persist_failed", {
      tenantId: tenant.id,
      leadId: lead.id,
      reason,
      error: (err as Error).message,
    });
  }
}
