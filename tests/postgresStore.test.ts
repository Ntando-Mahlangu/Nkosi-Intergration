import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAuditLogStore,
  PostgresLeadStore,
  PostgresMessageStore,
  PostgresNotificationStore,
  PostgresTenantStore,
} from "../src/store/postgres.js";
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

  it("falls back to a previous encryption key for rows not yet rotated", async () => {
    const oldKey = TEST_ENCRYPTION_KEY;
    const newKey = generateEncryptionKey();
    const tenantStore = new PostgresTenantStore(pool, oldKey);
    await tenantStore.createTenant(TENANT);

    // Configured with the new key as primary and the old key as fallback —
    // this row is still encrypted under the old key (not yet rotated).
    const duringRotation = new PostgresTenantStore(pool, newKey, oldKey);
    const reread = await duringRotation.getTenant(TENANT.id);
    expect(reread?.channels.sms?.authToken).toBe(TENANT.channels.sms?.authToken);
  });

  it("without a previous key configured, still throws on a row encrypted under a different key", async () => {
    const oldKey = TEST_ENCRYPTION_KEY;
    const newKey = generateEncryptionKey();
    const tenantStore = new PostgresTenantStore(pool, oldKey);
    await tenantStore.createTenant(TENANT);

    const storeWithOnlyNewKey = new PostgresTenantStore(pool, newKey);
    await expect(storeWithOnlyNewKey.getTenant(TENANT.id)).rejects.toThrow();
  });

  it("supports the full rotation pattern: re-encrypting every tenant from an old key to a new one", async () => {
    // Exercises exactly what src/scripts/rotateEncryptionKey.ts does.
    // Regression test: updateTenant() re-reads the existing row internally
    // before merging the patch, so the *write* store also needs the old
    // key as a fallback — the row being overwritten isn't rotated yet at
    // that point, even though the new key is what should be used going
    // forward. Missing that fallback on the write side breaks the whole
    // rotation with an opaque decrypt error.
    const oldKey = TEST_ENCRYPTION_KEY;
    const newKey = generateEncryptionKey();
    const readWithOldKey = new PostgresTenantStore(pool, oldKey);
    await readWithOldKey.createTenant(TENANT);

    const writeWithNewKey = new PostgresTenantStore(pool, newKey, oldKey);
    const fresh = await readWithOldKey.getTenant(TENANT.id);
    await writeWithNewKey.updateTenant(TENANT.id, { channels: fresh!.channels });

    const storeWithOnlyNewKey = new PostgresTenantStore(pool, newKey);
    const rotated = await storeWithOnlyNewKey.getTenant(TENANT.id);
    expect(rotated?.channels.sms?.authToken).toBe(TENANT.channels.sms?.authToken);

    const storeWithOnlyOldKey = new PostgresTenantStore(pool, oldKey);
    await expect(storeWithOnlyOldKey.getTenant(TENANT.id)).rejects.toThrow();
  });

  it("listTenants (as the rotation script's read side does) survives a re-run after a partial rotation", async () => {
    // Regression test for a real bug: rotateEncryptionKey.ts re-run after it
    // partially succeeded (one tenant already re-encrypted under the new
    // key, another not yet) used to crash listTenants() itself — before even
    // reaching the per-tenant try/catch — because the read-side store had no
    // way to decode a row already under the new key. Fixed by giving the
    // read-side store the new key as its previousEncryptionKey fallback too.
    const oldKey = TEST_ENCRYPTION_KEY;
    const newKey = generateEncryptionKey();
    const setupStore = new PostgresTenantStore(pool, oldKey);
    await setupStore.createTenant(TENANT);
    await setupStore.createTenant({ ...TENANT, id: "tenant-2", apiKey: "test-key-2" });

    // Simulate a rotation already completed for TENANT (but not tenant-2).
    const writeWithNewKey = new PostgresTenantStore(pool, newKey, oldKey);
    const fresh = await setupStore.getTenant(TENANT.id);
    await writeWithNewKey.updateTenant(TENANT.id, { channels: fresh!.channels });

    // This is exactly how the (fixed) script constructs its read-side store.
    const readWithOldKey = new PostgresTenantStore(pool, oldKey, newKey);
    const tenants = await readWithOldKey.listTenants();
    expect(tenants).toHaveLength(2);
    expect(tenants.find((t) => t.id === TENANT.id)?.channels.sms?.authToken).toBe(TENANT.channels.sms?.authToken);
    expect(tenants.find((t) => t.id === "tenant-2")?.channels.sms?.authToken).toBe(TENANT.channels.sms?.authToken);
  });

  it("survives two concurrent updateTenant calls patching different fields (no lost update)", async () => {
    // Regression test: updateTenant() used to read the row, merge the patch
    // in JS, then write every column back — so two concurrent callers each
    // patching a different field could each read the row before the other's
    // write landed, and whichever wrote last would silently revert the
    // other's change (e.g. a tenant's own settings save reverting an
    // admin's concurrent suspension, or vice versa). Firing both patches via
    // Promise.all lets their internal reads genuinely interleave — this
    // only passes because the fix writes just the patched column, not a
    // full-row snapshot.
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);

    await Promise.all([
      tenantStore.updateTenant(TENANT.id, { knowledgeBase: "concurrent write A" }),
      tenantStore.updateTenant(TENANT.id, { status: "suspended" }),
    ]);

    const reread = await tenantStore.getTenant(TENANT.id);
    expect(reread?.knowledgeBase).toBe("concurrent write A");
    expect(reread?.status).toBe("suspended");
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

  it("round-trips appointmentAt/appointmentReminderSentAt", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);
    const leadStore = new PostgresLeadStore(pool);
    await leadStore.createLead(LEAD);

    const booked = await leadStore.updateLead(TENANT.id, LEAD.id, {
      appointmentStatus: "booked",
      appointmentAt: new Date("2026-12-01T10:00:00.000Z").toISOString(),
    });
    expect(booked?.appointmentAt).toBe("2026-12-01T10:00:00.000Z");
    expect(booked?.appointmentReminderSentAt).toBeUndefined();

    const reminded = await leadStore.updateLead(TENANT.id, LEAD.id, {
      appointmentReminderSentAt: new Date("2026-11-30T10:00:00.000Z").toISOString(),
    });
    expect(reminded?.appointmentReminderSentAt).toBe("2026-11-30T10:00:00.000Z");

    const reread = await leadStore.getLeadById(TENANT.id, LEAD.id);
    expect(reread?.appointmentAt).toBe("2026-12-01T10:00:00.000Z");
    expect(reread?.appointmentReminderSentAt).toBe("2026-11-30T10:00:00.000Z");
  });

  it("round-trips a tenant's reference-only contactPhone/contactEmail/website", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant({
      ...TENANT,
      contactPhone: "(555) 123-4567",
      contactEmail: "owner@acmeplumbing.com",
      website: "https://acmeplumbing.com",
    });

    const fetched = await tenantStore.getTenant(TENANT.id);
    expect(fetched?.contactPhone).toBe("(555) 123-4567");
    expect(fetched?.contactEmail).toBe("owner@acmeplumbing.com");
    expect(fetched?.website).toBe("https://acmeplumbing.com");

    const updated = await tenantStore.updateTenant(TENANT.id, { contactPhone: "(555) 999-0000" });
    expect(updated?.contactPhone).toBe("(555) 999-0000");
    expect(updated?.contactEmail).toBe("owner@acmeplumbing.com"); // untouched
  });

  it("survives two concurrent updateLead calls patching different fields (no lost update)", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    await tenantStore.createTenant(TENANT);
    await leadStore.createLead(LEAD);

    await Promise.all([
      leadStore.updateLead(TENANT.id, LEAD.id, { notes: "called, left voicemail" }),
      leadStore.updateLead(TENANT.id, LEAD.id, { status: "opted_out" }),
    ]);

    const reread = await leadStore.getLeadById(TENANT.id, LEAD.id);
    expect(reread?.notes).toBe("called, left voicemail");
    expect(reread?.status).toBe("opted_out");
  });

  it("updateLead's guard skips the patch if the lead's status already moved on, returning its current state instead", async () => {
    // Regression test for workflow.ts's outreach-status write: it patches
    // {status: "contacted_no_response", ...} guarded on the status the send
    // was planned against, so a reply that lands mid-send (opted_out here)
    // isn't silently overwritten back to "contacted_no_response".
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    await tenantStore.createTenant(TENANT);
    await leadStore.createLead(LEAD); // status: "new"

    await leadStore.updateLead(TENANT.id, LEAD.id, { status: "opted_out" });

    const guarded = await leadStore.updateLead(
      TENANT.id,
      LEAD.id,
      { status: "contacted_no_response", notes: "sent follow-up" },
      { onlyIfStatusIn: ["new"] } // stale: the plan was built when status was still "new"
    );
    expect(guarded?.status).toBe("opted_out");
    expect(guarded?.notes).toBeUndefined(); // the whole guarded patch was skipped, not just `status`

    const reread = await leadStore.getLeadById(TENANT.id, LEAD.id);
    expect(reread?.status).toBe("opted_out");
  });

  it("updateLead's guard applies the patch normally when the status still matches", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    await tenantStore.createTenant(TENANT);
    await leadStore.createLead(LEAD); // status: "new"

    const updated = await leadStore.updateLead(
      TENANT.id,
      LEAD.id,
      { status: "contacted_no_response" },
      { onlyIfStatusIn: ["new"] }
    );
    expect(updated?.status).toBe("contacted_no_response");
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

  it("listForTenant returns every message across leads, scoped by tenant and an optional since/until window", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const leadStore = new PostgresLeadStore(pool);
    const messageStore = new PostgresMessageStore(pool);
    await tenantStore.createTenant(TENANT);
    await tenantStore.createTenant({ ...TENANT, id: "tenant-2", apiKey: "other-key" });
    await leadStore.createLead(LEAD);
    await leadStore.createLead({ ...LEAD, id: "lead-2", tenantId: "tenant-2" });

    await messageStore.logMessage({
      id: "msg-old",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "outbound",
      body: "old",
      at: new Date("2020-01-01T00:00:00.000Z").toISOString(),
    });
    await messageStore.logMessage({
      id: "msg-recent",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "inbound",
      body: "recent",
      at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      classification: "interested",
    });
    await messageStore.logMessage({
      id: "msg-other-tenant",
      tenantId: "tenant-2",
      leadId: "lead-2",
      channel: "sms",
      direction: "outbound",
      body: "not this tenant",
      at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
    });

    const all = await messageStore.listForTenant(TENANT.id);
    expect(all.map((m) => m.id)).toEqual(["msg-old", "msg-recent"]); // scoped to the tenant, chronological

    const windowed = await messageStore.listForTenant(TENANT.id, { since: "2025-01-01T00:00:00.000Z" });
    expect(windowed.map((m) => m.id)).toEqual(["msg-recent"]);
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

  it("round-trips paddleSubscriptionId and supports lookup by it", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant({ ...TENANT, paddleSubscriptionId: "sub_created" });

    const byId = await tenantStore.getTenant(TENANT.id);
    expect(byId?.paddleSubscriptionId).toBe("sub_created");

    const bySubscription = await tenantStore.getTenantByPaddleSubscriptionId("sub_created");
    expect(bySubscription?.id).toBe(TENANT.id);

    const updated = await tenantStore.updateTenant(TENANT.id, { paddleSubscriptionId: "sub_corrected" });
    expect(updated?.paddleSubscriptionId).toBe("sub_corrected");
    expect(await tenantStore.getTenantByPaddleSubscriptionId("sub_created")).toBeUndefined();
    expect((await tenantStore.getTenantByPaddleSubscriptionId("sub_corrected"))?.id).toBe(TENANT.id);
  });

  it("round-trips statusReason", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    await tenantStore.createTenant(TENANT);
    expect((await tenantStore.getTenant(TENANT.id))?.statusReason).toBeUndefined();

    const suspended = await tenantStore.updateTenant(TENANT.id, { status: "suspended", statusReason: "billing" });
    expect(suspended?.statusReason).toBe("billing");
    expect((await tenantStore.getTenant(TENANT.id))?.statusReason).toBe("billing");

    const reactivated = await tenantStore.updateTenant(TENANT.id, { status: "active", statusReason: "manual" });
    expect(reactivated?.statusReason).toBe("manual");
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

  it("round-trips a failed notification and supports the delivered/dead lifecycle", async () => {
    const notificationStore = new PostgresNotificationStore(pool);
    const recorded = await notificationStore.recordFailure({
      tenantId: TENANT.id,
      leadId: LEAD.id,
      reason: "interested",
      webhookUrl: "https://hooks.example.com/notify",
      payload: { text: "hi", event: "lead_interested" },
      error: "network down",
    });
    expect(recorded.attempts).toBe(1);
    expect(recorded.status).toBe("pending");

    const pending = await notificationStore.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toEqual({ text: "hi", event: "lead_interested" });

    await notificationStore.markAttemptFailed(recorded.id, "still down", 2);
    const [afterSecondFailure] = await notificationStore.listAll();
    expect(afterSecondFailure.attempts).toBe(2);
    expect(afterSecondFailure.status).toBe("dead");
    expect(await notificationStore.listPending()).toHaveLength(0);
  });

  it("removes a failed notification from listPending/listAll once markDelivered", async () => {
    const notificationStore = new PostgresNotificationStore(pool);
    const recorded = await notificationStore.recordFailure({
      tenantId: TENANT.id,
      reason: "needs_human_reply",
      webhookUrl: "https://hooks.example.com/notify",
      payload: { text: "hi" },
      error: "boom",
    });
    await notificationStore.markDelivered(recorded.id);
    expect(await notificationStore.listAll()).toHaveLength(0);
  });

  it("records and lists audit log entries, newest first, with pagination", async () => {
    const auditLogStore = new PostgresAuditLogStore(pool);
    await auditLogStore.record({
      tenantId: TENANT.id,
      action: "tenant.create",
      actor: "admin",
      details: { name: "Acme Co" },
    });
    await auditLogStore.record({
      tenantId: TENANT.id,
      action: "tenant.admin_update",
      actor: "admin",
      details: { fieldsChanged: ["status"] },
    });
    await auditLogStore.record({ tenantId: TENANT.id, action: "tenant.delete", actor: "admin" });

    expect(await auditLogStore.count()).toBe(3);

    const all = await auditLogStore.list({ offset: 0 });
    expect(all.map((e) => e.action)).toEqual(["tenant.delete", "tenant.admin_update", "tenant.create"]);

    const page = await auditLogStore.list({ limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].action).toBe("tenant.admin_update");
  });

  it("audit log entries survive the tenant they describe being deleted", async () => {
    const tenantStore = new PostgresTenantStore(pool, TEST_ENCRYPTION_KEY);
    const auditLogStore = new PostgresAuditLogStore(pool);
    await tenantStore.createTenant(TENANT);
    await auditLogStore.record({ tenantId: TENANT.id, action: "tenant.delete", actor: "admin" });

    await tenantStore.deleteTenant(TENANT.id);

    expect(await auditLogStore.count()).toBe(1);
  });
});
