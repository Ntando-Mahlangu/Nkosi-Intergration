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
 * SMS and WhatsApp require carrier-side approval (10DLC registration,
 * WhatsApp Business template approval) before sending at any real volume —
 * see COMPLIANCE.md "SMS / WhatsApp (Twilio)". Email has no equivalent
 * requirement. devMode (local/demo use only) always bypasses this.
 */
const CARRIER_APPROVAL_REQUIRED_CHANNELS: ReadonlySet<Channel> = new Set(["sms", "whatsapp"]);

export function hasCarrierApproval(tenant: Tenant, channel: Channel): boolean {
  if (!CARRIER_APPROVAL_REQUIRED_CHANNELS.has(channel)) return true;
  return Boolean(tenant.devMode) || Boolean(tenant.carrierApprovalConfirmedAt);
}

function isChannelUsable(tenant: Tenant, lead: Lead, channel: Channel): boolean {
  return ADAPTERS[channel].canSend(tenant, lead) && hasCarrierApproval(tenant, channel);
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
 * which we actually have contact info and a usable provider — "usable"
 * also requires carrier approval for sms/whatsapp (hasCarrierApproval
 * above), so an unconfirmed tenant transparently falls back to email (or
 * is skipped as having no usable channel) rather than sending SMS/WhatsApp
 * it isn't yet cleared to send.
 */
export function selectChannel(tenant: Tenant, lead: Lead): Channel | undefined {
  if (lead.preferredChannel && isChannelUsable(tenant, lead, lead.preferredChannel)) {
    return lead.preferredChannel;
  }
  return CHANNEL_PRIORITY.find((channel) => isChannelUsable(tenant, lead, channel));
}
