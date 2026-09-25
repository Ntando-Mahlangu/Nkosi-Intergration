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
  createdAt: new Date(0).toISOString(),
};
