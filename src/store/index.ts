import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Lead } from "../types.js";
import { DEMO_TENANT } from "../demoTenant.js";
import {
  InMemoryAuditLogStore,
  InMemoryLeadStore,
  InMemoryMessageStore,
  InMemoryNotificationStore,
  InMemoryTenantStore,
} from "./memory.js";
import {
  PostgresAuditLogStore,
  PostgresLeadStore,
  PostgresMessageStore,
  PostgresNotificationStore,
  PostgresTenantStore,
} from "./postgres.js";
import { getPool } from "../db/pool.js";
import type { AuditLogStore, LeadStore, MessageStore, NotificationStore, TenantStore } from "./types.js";

export * from "./types.js";
export * from "./memory.js";
export * from "./postgres.js";

export interface Stores {
  leadStore: LeadStore;
  tenantStore: TenantStore;
  messageStore: MessageStore;
  notificationStore: NotificationStore;
  auditLogStore: AuditLogStore;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadSampleLeads(): Lead[] {
  const dataPath = path.join(__dirname, "..", "..", "data", "sample-leads.json");
  const raw: Omit<Lead, "tenantId">[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  return raw.map((lead) => ({ ...lead, tenantId: DEMO_TENANT.id }));
}

/**
 * Creates the storage layer for the app. Uses Postgres when DATABASE_URL is
 * set (production/staging); otherwise falls back to an in-memory store
 * preloaded with the demo tenant and sample leads, so the CLI/server/tests
 * work out of the box with zero external services.
 */
export function createStores(): Stores {
  if (process.env.DATABASE_URL) {
    const encryptionKey = process.env.LEADRECOVERY_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error(
        "LEADRECOVERY_ENCRYPTION_KEY is required when DATABASE_URL is set — tenant provider " +
          "credentials (Twilio/SendGrid) are encrypted at rest with it. Generate one with " +
          "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`."
      );
    }
    const pool = getPool();
    return {
      leadStore: new PostgresLeadStore(pool),
      tenantStore: new PostgresTenantStore(pool, encryptionKey, process.env.LEADRECOVERY_ENCRYPTION_KEY_PREVIOUS),
      messageStore: new PostgresMessageStore(pool),
      notificationStore: new PostgresNotificationStore(pool),
      auditLogStore: new PostgresAuditLogStore(pool),
    };
  }

  return {
    leadStore: new InMemoryLeadStore(loadSampleLeads()),
    tenantStore: new InMemoryTenantStore([DEMO_TENANT]),
    messageStore: new InMemoryMessageStore(),
    notificationStore: new InMemoryNotificationStore(),
    auditLogStore: new InMemoryAuditLogStore(),
  };
}
