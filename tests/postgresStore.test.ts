import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresLeadStore, PostgresMessageStore, PostgresTenantStore } from "../src/store/postgres.js";
import type { Lead, Message, Tenant } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.join(__dirname, "..", "src", "db", "migrations", "0001_init.sql"),
  "utf-8"
);

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
    await pool.query(MIGRATION_SQL);
  });

  it("round-trips a tenant, including quiet hours and channel credentials", async () => {
    const tenantStore = new PostgresTenantStore(pool);
    await tenantStore.createTenant(TENANT);

    const byId = await tenantStore.getTenant(TENANT.id);
    expect(byId).toEqual(TENANT);

    const byKey = await tenantStore.getTenantByApiKey(TENANT.apiKey);
    expect(byKey?.id).toBe(TENANT.id);
    expect(byKey?.channels.sms?.fromNumber).toBe("+15550000");

    const missing = await tenantStore.getTenantByApiKey("nope");
    expect(missing).toBeUndefined();
  });

  it("round-trips a lead and supports lookup by phone/email and partial updates", async () => {
    const tenantStore = new PostgresTenantStore(pool);
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
    const tenantStore = new PostgresTenantStore(pool);
    const leadStore = new PostgresLeadStore(pool);
    await tenantStore.createTenant(TENANT);
    await tenantStore.createTenant({ ...TENANT, id: "tenant-2", apiKey: "other-key" });

    await leadStore.createLead(LEAD);
    await leadStore.createLead({ ...LEAD, id: "lead-2", tenantId: "tenant-2" });

    expect(await leadStore.getLeadById("tenant-2", "lead-1")).toBeUndefined();
    expect(await leadStore.getAllLeads("tenant-2")).toHaveLength(1);
  });

  it("logs and retrieves messages for a lead in chronological order", async () => {
    const tenantStore = new PostgresTenantStore(pool);
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
});
