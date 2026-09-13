import sgMail from "@sendgrid/mail";
import type { Lead, Tenant } from "../types.js";
import type { ChannelAdapter, SendResult } from "./types.js";

/**
 * Email adapter via SendGrid. Falls back to console logging in devMode,
 * same as the other adapters.
 */
export const emailAdapter: ChannelAdapter = {
  channel: "email",

  canSend(tenant: Tenant, lead: Lead): boolean {
    return Boolean(lead.email) && (Boolean(tenant.channels.email) || Boolean(tenant.devMode));
  },

  async send(tenant: Tenant, lead: Lead, message): Promise<SendResult> {
    if (!lead.email) {
      return { ok: false, channel: "email", detail: "no email address on file" };
    }

    const creds = tenant.channels.email;
    if (creds) {
      sgMail.setApiKey(creds.apiKey);
      const [response] = await sgMail.send({
        to: lead.email,
        from: creds.fromName ? { email: creds.fromEmail, name: creds.fromName } : creds.fromEmail,
        subject: `${tenant.name}`,
        text: message.body,
      });
      return { ok: true, channel: "email", detail: `status ${response.statusCode}` };
    }

    if (tenant.devMode) {
      console.log(`[Email(dev) -> ${lead.email}] ${message.body}`);
      return { ok: true, channel: "email", detail: "dev-mode console log (no SendGrid credentials configured)" };
    }

    return { ok: false, channel: "email", detail: "no email provider configured for this tenant" };
  },
};
