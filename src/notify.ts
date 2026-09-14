import type { Channel, Lead, Tenant } from "./types.js";

export type NotifyReason = "interested" | "needs_human_reply";

const SUMMARIES: Record<NotifyReason, (lead: Lead, channel: Channel, body: string) => string> = {
  interested: (lead, channel, body) => `🔥 ${lead.name ?? lead.id} replied "interested" via ${channel}: "${body}"`,
  needs_human_reply: (lead, channel, body) =>
    `🙋 ${lead.name ?? lead.id} needs a human reply via ${channel} (auto-reply couldn't answer): "${body}"`,
};

const EVENT_NAMES: Record<NotifyReason, string> = {
  interested: "lead_interested",
  needs_human_reply: "needs_human_reply",
};

/**
 * Best-effort notification for the two cases a human should act on
 * promptly: a reply classified "interested", or one the auto-reply
 * chatbot couldn't confidently answer from the knowledge base and
 * escalated. POSTs a JSON body to tenant.notifyWebhookUrl; the `text`
 * field makes it work directly as a Slack (or similar) incoming webhook,
 * while the rest of the payload is there for a custom endpoint to use.
 * Never throws — a broken notification target must never fail the inbound
 * webhook request that triggered it.
 */
export async function notifyHumanAttention(
  tenant: Tenant,
  lead: Lead,
  channel: Channel,
  body: string,
  reason: NotifyReason
): Promise<void> {
  if (!tenant.notifyWebhookUrl) return;

  try {
    const res = await fetch(tenant.notifyWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: SUMMARIES[reason](lead, channel, body),
        event: EVENT_NAMES[reason],
        tenantId: tenant.id,
        lead: { id: lead.id, name: lead.name, phone: lead.phone, email: lead.email, requestedService: lead.requestedService },
        channel,
        message: body,
      }),
    });
    if (!res.ok) {
      console.error(`notifyHumanAttention: ${tenant.notifyWebhookUrl} responded ${res.status}`);
    }
  } catch (err) {
    console.error(`notifyHumanAttention: failed to reach ${tenant.notifyWebhookUrl}:`, err);
  }
}
