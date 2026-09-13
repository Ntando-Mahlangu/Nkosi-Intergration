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
  createdAt: new Date(0).toISOString(),
};
