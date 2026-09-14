import twilio from "twilio";
import type { Lead, Tenant } from "../types.js";
import type { ChannelAdapter, SendResult } from "./types.js";
import { publicBaseUrl } from "../publicUrl.js";

function toWhatsAppAddress(e164: string): string {
  return e164.startsWith("whatsapp:") ? e164 : `whatsapp:${e164}`;
}

/**
 * WhatsApp adapter via Twilio's WhatsApp Business API integration. Requires
 * the tenant's WhatsApp sender to already be approved/configured in Twilio
 * (that approval process is external to this app — see COMPLIANCE.md).
 * Falls back to console logging in devMode, same as the SMS adapter.
 */
export const whatsappAdapter: ChannelAdapter = {
  channel: "whatsapp",

  canSend(tenant: Tenant, lead: Lead): boolean {
    return Boolean(lead.phone) && (Boolean(tenant.channels.whatsapp) || Boolean(tenant.devMode));
  },

  async send(tenant: Tenant, lead: Lead, message, messageId: string): Promise<SendResult> {
    if (!lead.phone) {
      return { ok: false, channel: "whatsapp", detail: "no phone number on file" };
    }

    const creds = tenant.channels.whatsapp;
    if (creds) {
      const client = twilio(creds.accountSid, creds.authToken);
      const base = publicBaseUrl();
      const result = await client.messages.create({
        to: toWhatsAppAddress(lead.phone),
        from: toWhatsAppAddress(creds.fromNumber),
        body: message.body,
        ...(base
          ? { statusCallback: `${base}/webhooks/${tenant.id}/twilio/status?messageId=${encodeURIComponent(messageId)}` }
          : {}),
      });
      return { ok: true, channel: "whatsapp", detail: result.sid, providerMessageId: result.sid };
    }

    if (tenant.devMode) {
      console.log(`[WhatsApp(dev) -> ${lead.phone}] ${message.body}`);
      return {
        ok: true,
        channel: "whatsapp",
        detail: "dev-mode console log (no Twilio WhatsApp credentials configured)",
      };
    }

    return { ok: false, channel: "whatsapp", detail: "no WhatsApp provider configured for this tenant" };
  },
};
