import type { Channel, ComposedMessage, Lead, Tenant } from "../types.js";

export interface SendResult {
  ok: boolean;
  channel: Channel;
  detail?: string;
  /** Provider's own id for this send (Twilio SID, etc.), when available — used to correlate delivery-status callbacks. */
  providerMessageId?: string;
}

/**
 * A channel adapter sends a composed message for a given tenant/lead. Real
 * sends use the tenant's own provider credentials (src/types.ts
 * ChannelCredentials); when a tenant has no credentials for a channel but is
 * in devMode, the adapter logs to the console instead so the pipeline can
 * be exercised locally without any provider account.
 *
 * `messageId` is LeadRecovery's own id for this message, generated before
 * the send — adapters that support delivery-status callbacks (Twilio
 * statusCallback, SendGrid custom_args) thread it through to the provider
 * so the inbound status webhook can correlate the callback back to our
 * Message record.
 */
export interface ChannelAdapter {
  channel: Channel;
  canSend(tenant: Tenant, lead: Lead): boolean;
  send(tenant: Tenant, lead: Lead, message: ComposedMessage, messageId: string): Promise<SendResult>;
}
