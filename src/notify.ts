import type { Channel, Lead, Tenant } from "./types.js";

/**
 * Best-effort notification when a reply classifies as "interested" — the
 * one reply type that usually wants a human on the client's side to act on
 * it quickly. POSTs a JSON body to tenant.notifyWebhookUrl; the `text` field
 * makes it work directly as a Slack (or similar) incoming webhook, while the
 * rest of the payload is there for a custom endpoint to use. Never throws —
 * a broken notification target must never fail the inbound webhook request
 * that triggered it.
 */
export async function notifyInterestedLead(tenant: Tenant, lead: Lead, channel: Channel, body: string): Promise<void> {
  if (!tenant.notifyWebhookUrl) return;

  const summary = `🔥 ${lead.name ?? lead.id} replied "interested" via ${channel}: "${body}"`;

  try {
    const res = await fetch(tenant.notifyWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: summary,
        event: "lead_interested",
        tenantId: tenant.id,
        lead: { id: lead.id, name: lead.name, phone: lead.phone, email: lead.email, requestedService: lead.requestedService },
        channel,
        message: body,
      }),
    });
    if (!res.ok) {
      console.error(`notifyInterestedLead: ${tenant.notifyWebhookUrl} responded ${res.status}`);
    }
  } catch (err) {
    console.error(`notifyInterestedLead: failed to reach ${tenant.notifyWebhookUrl}:`, err);
  }
}
