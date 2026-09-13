import { CHANNEL_PRIORITY, type Channel, type Lead, type Tenant } from "../types.js";
import type { ChannelAdapter } from "./types.js";
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
