import type { Channel, ComposedMessage, Lead, Tenant } from "../types.js";

export interface SendResult {
  ok: boolean;
  channel: Channel;
  detail?: string;
}

/**
 * A channel adapter sends a composed message for a given tenant/lead. Real
 * sends use the tenant's own provider credentials (src/types.ts
 * ChannelCredentials); when a tenant has no credentials for a channel but is
 * in devMode, the adapter logs to the console instead so the pipeline can
 * be exercised locally without any provider account.
 */
export interface ChannelAdapter {
  channel: Channel;
  canSend(tenant: Tenant, lead: Lead): boolean;
  send(tenant: Tenant, lead: Lead, message: ComposedMessage): Promise<SendResult>;
}
