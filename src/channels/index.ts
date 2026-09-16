import { CHANNEL_PRIORITY, type Channel, type ComposedMessage, type Lead, type Tenant } from "../types.js";
import type { ChannelAdapter, SendResult } from "./types.js";
import { smsAdapter } from "./sms.js";
import { whatsappAdapter } from "./whatsapp.js";
import { emailAdapter } from "./email.js";

export * from "./types.js";

const ADAPTERS: Record<Channel, ChannelAdapter> = {
  sms: smsAdapter,
  whatsapp: whatsappAdapter,
  email: emailAdapter,
};

export function getAdapter(channel: Channel): ChannelAdapter {
  return ADAPTERS[channel];
}

/**
 * Sends through the given channel, converting a thrown provider-level error
 * (Twilio/SendGrid can throw, not just return {ok: false} — an invalid
 * phone number, a blocked recipient, a revoked key) into the same
 * {ok: false} shape an adapter already returns for an expected failure.
 * Callers loop over many leads or handle one request at a time; either way,
 * one bad send must never abort whatever's calling this. Never throws.
 */
export async function safeSend(
  channel: Channel,
  tenant: Tenant,
  lead: Lead,
  message: ComposedMessage,
  messageId: string
): Promise<SendResult> {
  try {
    return await getAdapter(channel).send(tenant, lead, message, messageId);
  } catch (err) {
    return { ok: false, channel, detail: (err as Error).message };
  }
}

/**
 * Picks the channel to use for a lead per SYSTEM_PROMPT.md STEP 4:
 * the business's configured channel if set and usable, otherwise the
 * first channel in the preferred order (SMS -> WhatsApp -> Email) for
 * which we actually have contact info and a usable provider.
 */
export function selectChannel(tenant: Tenant, lead: Lead): Channel | undefined {
  if (lead.preferredChannel && ADAPTERS[lead.preferredChannel].canSend(tenant, lead)) {
    return lead.preferredChannel;
  }
  return CHANNEL_PRIORITY.find((channel) => ADAPTERS[channel].canSend(tenant, lead));
}
