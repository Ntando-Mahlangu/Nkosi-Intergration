import type { Tenant } from "./types.js";

/**
 * A tenant with no real channel credentials, used by the CLI and the
 * default (no DATABASE_URL) server mode so the whole pipeline can be
 * exercised locally without any provider accounts. devMode makes the
 * channel adapters log to the console instead of refusing to send.
 */
export const DEMO_TENANT: Tenant = {
  id: "demo",
  name: "Nkosi Integrations (Demo)",
  apiKey: "demo-key",
  timezone: "Africa/Johannesburg",
  devMode: true,
  channels: {},
  // Grandfathered — see migration 0013's own comment: a brand-new tenant
  // must accept the Terms of Service before anything actually sends, but
  // the bundled demo should work out of the box with no extra click.
  termsAcceptedAt: new Date(0).toISOString(),
  termsVersion: "grandfathered",
  // Also grandfathered, same rationale — see migration 0014's own comment.
  // devMode already bypasses the carrier-approval gate regardless, but this
  // keeps the demo tenant's attestation fields consistent with a real
  // grandfathered tenant rather than looking like an unconfirmed one.
  consentBasisConfirmedAt: new Date(0).toISOString(),
  carrierApprovalConfirmedAt: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
};
