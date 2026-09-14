import twilio from "twilio";
import type { Lead, Tenant } from "../types.js";
import type { ChannelAdapter, SendResult } from "./types.js";
import { publicBaseUrl } from "../publicUrl.js";

/**
 * SMS adapter. With real Twilio credentials configured on the tenant, sends
 * a live SMS. Otherwise, when the tenant is in devMode, logs to the console
 * so the workflow can be exercised without a Twilio account.
 */
export const smsAdapter: ChannelAdapter = {
  channel: "sms",

  canSend(tenant: Tenant, lead: Lead): boolean {
    return Boolean(lead.phone) && (Boolean(tenant.channels.sms) || Boolean(tenant.devMode));
  },

  async send(tenant: Tenant, lead: Lead, message, messageId: string): Promise<SendResult> {
    if (!lead.phone) {
      return { ok: false, channel: "sms", detail: "no phone number on file" };
    }

    const creds = tenant.channels.sms;
    if (creds) {
      const client = twilio(creds.accountSid, creds.authToken);
      const base = publicBaseUrl();
      const result = await client.messages.create({
        to: lead.phone,
        from: creds.fromNumber,
        body: message.body,
        ...(base
          ? { statusCallback: `${base}/webhooks/${tenant.id}/twilio/status?messageId=${encodeURIComponent(messageId)}` }
          : {}),
      });
      return { ok: true, channel: "sms", detail: result.sid, providerMessageId: result.sid };
    }

    if (tenant.devMode) {
      console.log(`[SMS(dev) -> ${lead.phone}] ${message.body}`);
      return { ok: true, channel: "sms", detail: "dev-mode console log (no Twilio credentials configured)" };
    }

    return { ok: false, channel: "sms", detail: "no SMS provider configured for this tenant" };
  },
};
