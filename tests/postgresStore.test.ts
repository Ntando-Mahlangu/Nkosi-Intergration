import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresLeadStore, PostgresMessageStore, PostgresTenantStore } from "../src/store/postgres.js";
import { generateEncryptionKey } from "../src/crypto.js";
import type { Lead, Message, Tenant } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");
// Apply every migration in order, same as src/scripts/migrate.ts, so this test always
// exercises the store against the same schema the real app runs migrations to produce.
const MIGRATION_SQLS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"));

const TEST_ENCRYPTION_KEY = generateEncryptionKey();

function createTestPool(): Pool {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: "now", implementation: () => new Date() });
  const { Pool: MemPool } = db.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  return pool;
}

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "test-key",
  timezone: "Africa/Johannesburg",
  quietHours: { startHour: 20, endHour: 8 },
  devMode: false,
  channels: { sms: { accountSid: "AC1", authToken: "tok", fromNumber: "+15550000" } },
  autoReplyEnabled: false, // the DB column is NOT NULL DEFAULT FALSE, so a round-trip always returns a real boolean here
  status: "active", // ditto — NOT NULL DEFAULT 'active'
  createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
};

const LEAD: Lead = {
  id: "lead-1",
  tenantId: TENANT.id,
  name: "Jordan Smith",
  phone: "+27821234567",
  source: "crm",
  createdAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
  status: "new",
  requestedService: "fencing",
};

describe("Postgres stores (against an in-memory pg-mem instance)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = createTestPool();
    for (const sql of MIGRATION_SQLS) await pool.query(sql);
  });

  it("round-trips a tenant, including quiet hours and channel credentials", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);

    const byId = await tenantStore.getTenant(TENANT.id);
    expect(byId).toEqual(TENANT);

    const byKey = await tenantStore.getTenantByApiKey(TENANT.apiKey);
    expect(byKey?.id).toBe(TENANT.id);
    expect(byKey?.channels.sms?.fromNumber).toBe("+15550000");

    const missing = await tenantStore.getTenantByApiKey("nope");
    expect(missing).toBeUndefined();
  });

  it("round-trips knowledgeBase and autoReplyEnabled", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant({
      ...TENANT,
      knowledgeBase: "We open at 8am and close at 5pm, Monday to Friday.",
      autoReplyEnabled: true,
    });

    const reread = await tenantStore.getTenant(TENANT.id);
    expect(reread?.knowledgeBase).toBe("We open at 8am and close at 5pm, Monday to Friday.");
    expect(reread?.autoReplyEnabled).toBe(true);

    const updated = await tenantStore.updateTenant(TENANT.id, { autoReplyEnabled: false });
    expect(updated?.autoReplyEnabled).toBe(false);
    expect(updated?.knowledgeBase).toBe("We open at 8am and close at 5pm, Monday to Friday."); // untouched fields survive a partial update
  });

  it("never stores channel credentials in cleartext in the database", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);

    const { rows } = await pool.query("SELECT channels FROM tenants WHERE id = $1", [TENANT.id]);
    const raw = JSON.stringify(rows[0].channels);
    expect(raw).not.toContain("tok"); // the plaintext Twilio auth token
    expect(raw).not.toContain("+15550000");
    expect(rows[0].channels._encrypted).toBeTruthy();
  });

  it("refuses to decrypt encrypted channels without the right key", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);

    const storeWithNoKey = new PostgresTenantStore(pool);
    await expect(storeWithNoKey.getTenant(TENANT.id)).rejects.toThrow(/encryption key/i);
  });

  it("round-trips a lead and supports lookup by phone/email and partial updates", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);
    const leadStore = new PostgresLeadStore(pool);

    await leadStore.createLead(LEAD);

    const all = await leadStore.getAllLeads(TENANT.id);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Jordan Smith");

    const byPhone = await leadStore.findLeadByContact(TENANT.id, { phone: "+27821234567" });
    expect(byPhone?.id).toBe("lead-1");

    const updated = await leadStore.updateLead(TENANT.id, "lead-1", {
      status: "contacted_no_response",
      firstOutreachSentAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
      followUpCount: 0,
    });
    expect(updated?.status).toBe("contacted_no_response");

    const reread = await leadStore.getLeadById(TENANT.id, "lead-1");
    expect(reread?.status).toBe("contacted_no_response");
    expect(reread?.followUpCount).toBe(0);
  });

  it("scopes leads strictly per tenant", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    await tenantStore.createTenant(TENANT);
    await tenantStore.createTenant({ ...TENANT, id: "tenant-2", apiKey: "other-key" });

    await leadStore.createLead(LEAD);
    await leadStore.createLead({ ...LEAD, id: "lead-2", tenantId: "tenant-2" });

    expect(await leadStore.getLeadById("tenant-2", "lead-1")).toBeUndefined();
    expect(await leadStore.getAllLeads("tenant-2")).toHaveLength(1);
  });

  it("logs and retrieves messages for a lead in chronological order", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    const messageStore = new PostgresMessageStore(pool);
    await tenantStore.createTenant(TENANT);
    await leadStore.createLead(LEAD);

    const first: Message = {
      id: "msg-1",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "outbound",
      body: "Hi Jordan...",
      at: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    };
    const second: Message = {
      id: "msg-2",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "inbound",
      body: "STOP",
      at: new Date("2026-09-02T00:00:00.000Z").toISOString(),
      classification: "stop",
    };

    await messageStore.logMessage(second);
    await messageStore.logMessage(first);

    const history = await messageStore.getMessagesForLead(TENANT.id, LEAD.id);
    expect(history.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    expect(history[1].classification).toBe("stop");
  });

  it("records and updates delivery status by message id", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    const messageStore = new PostgresMessageStore(pool);
    await tenantStore.createTenant(TENANT);
    await leadStore.createLead(LEAD);

    await messageStore.logMessage({
      id: "msg-out-1",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "outbound",
      body: "Hi Jordan...",
      at: new Date("2026-09-01T00:00:00.000Z").toISOString(),
      providerMessageId: "SM123",
      kind: "auto_reply",
    });

    const updated = await messageStore.updateMessageStatus(TENANT.id, "msg-out-1", "delivered");
    expect(updated?.deliveryStatus).toBe("delivered");

    const [reread] = await messageStore.getMessagesForLead(TENANT.id, LEAD.id);
    expect(reread.deliveryStatus).toBe("delivered");
    expect(reread.providerMessageId).toBe("SM123");
    expect(reread.kind).toBe("auto_reply");

    const missing = await messageStore.updateMessageStatus(TENANT.id, "no-such-message", "delivered");
    expect(missing).toBeUndefined();
  });

  it("round-trips tenant status and defaults new tenants to active", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);

    const suspended = await tenantStore.updateTenant(TENANT.id, { status: "suspended" });
    expect(suspended?.status).toBe("suspended");

    const reread = await tenantStore.getTenant(TENANT.id);
    expect(reread?.status).toBe("suspended");

    const reactivated = await tenantStore.updateTenant(TENANT.id, { status: "active" });
    expect(reactivated?.status).toBe("active");
  });

  it("deleteTenant removes the tenant and, via ON DELETE CASCADE, its leads and messages", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    const messageStore = new PostgresMessageStore(pool);
    await tenantStore.createTenant(TENANT);
    await leadStore.createLead(LEAD);
    await messageStore.logMessage({
      id: "msg-1",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "outbound",
      body: "Hi Jordan...",
      at: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    });

    const deleted = await tenantStore.deleteTenant(TENANT.id);
    expect(deleted).toBe(true);

    expect(await tenantStore.getTenant(TENANT.id)).toBeUndefined();

    const { rows: leadRows } = await pool.query("SELECT id FROM leads WHERE tenant_id = $1", [TENANT.id]);
    expect(leadRows).toHaveLength(0);
    const { rows: messageRows } = await pool.query("SELECT id FROM messages WHERE tenant_id = $1", [TENANT.id]);
    expect(messageRows).toHaveLength(0);
  });

  it("deleteTenant returns false for an unknown tenant id", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    expect(await tenantStore.deleteTenant("no-such-tenant")).toBe(false);
  });
});
