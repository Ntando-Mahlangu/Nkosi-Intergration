import type { Lead } from "../types.js";
import type { ChannelAdapter, SendResult } from "./types.js";

/**
 * Mock WhatsApp adapter. Swap the `send` body for a real provider call
 * (e.g. the WhatsApp Business Cloud API) to go live.
 */
export const whatsappAdapter: ChannelAdapter = {
  channel: "whatsapp",
  canSend(lead: Lead): boolean {
    return Boolean(lead.phone);
  },
  async send(lead: Lead, message): Promise<SendResult> {
    if (!lead.phone) {
      return { ok: false, channel: "whatsapp", detail: "no phone number on file" };
    }
    console.log(`[WhatsApp -> ${lead.phone}] ${message.body}`);
    return { ok: true, channel: "whatsapp" };
  },
};
