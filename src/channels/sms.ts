import type { Lead } from "../types.js";
import type { ChannelAdapter, SendResult } from "./types.js";

/**
 * Mock SMS adapter. Swap the `send` body for a real provider call
 * (e.g. Twilio's Messages API) to go live — the rest of the workflow
 * doesn't need to change.
 */
export const smsAdapter: ChannelAdapter = {
  channel: "sms",
  canSend(lead: Lead): boolean {
    return Boolean(lead.phone);
  },
  async send(lead: Lead, message): Promise<SendResult> {
    if (!lead.phone) {
      return { ok: false, channel: "sms", detail: "no phone number on file" };
    }
    console.log(`[SMS -> ${lead.phone}] ${message.body}`);
    return { ok: true, channel: "sms" };
  },
};
