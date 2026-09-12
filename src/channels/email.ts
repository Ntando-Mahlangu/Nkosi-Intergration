import type { Lead } from "../types.js";
import type { ChannelAdapter, SendResult } from "./types.js";

/**
 * Mock Email adapter. Swap the `send` body for a real provider call
 * (e.g. SendGrid, Postmark) to go live.
 */
export const emailAdapter: ChannelAdapter = {
  channel: "email",
  canSend(lead: Lead): boolean {
    return Boolean(lead.email);
  },
  async send(lead: Lead, message): Promise<SendResult> {
    if (!lead.email) {
      return { ok: false, channel: "email", detail: "no email address on file" };
    }
    console.log(`[Email -> ${lead.email}] ${message.body}`);
    return { ok: true, channel: "email" };
  },
};
