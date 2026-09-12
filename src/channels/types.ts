import type { Channel, ComposedMessage, Lead } from "../types.js";

export interface SendResult {
  ok: boolean;
  channel: Channel;
  detail?: string;
}

/**
 * A channel adapter is the swap-in point for a real provider (Twilio for
 * SMS/WhatsApp, an email API for Email, etc.). The mock adapters in this
 * directory just log to the console so the workflow can be exercised
 * end-to-end without any credentials configured.
 */
export interface ChannelAdapter {
  channel: Channel;
  canSend(lead: Lead): boolean;
  send(lead: Lead, message: ComposedMessage): Promise<SendResult>;
}
