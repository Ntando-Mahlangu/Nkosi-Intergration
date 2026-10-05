import { describe, expect, it } from "vitest";
import { alertStaleAttentionItems } from "../src/attentionSlaAlert.js";
import { InMemoryLeadStore } from "../src/store/memory.js";
import type { LeadStore } from "../src/store/types.js";
import type { Lead, Tenant } from "../src/types.js";

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant-1",
    name: "Acme Co",
    apiKey: "key",
    timezone: "UTC",
    channels: {},
    attentionSlaHours: 12,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    tenantId: "tenant-1",
    source: "crm",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    status: "responded",
    ...overrides,
  };
}

describe("alertStaleAttentionItems", () => {
  const now = new Date("2026-01-02T00:00:00.000Z"); // 24h after needsAttentionAt below

  it("alerts a genuinely stale lead and marks attentionAlertedAt", async () => {
    const tenant = makeTenant();
    const lead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z", needsAttentionReason: "interested" });
    const leadStore = new InMemoryLeadStore([lead]);

    await alertStaleAttentionItems(leadStore, [tenant], now);

    const updated = await leadStore.getLeadById(tenant.id, lead.id);
    expect(updated?.attentionAlertedAt).toBeTruthy();
  });

  it("skips a tenant with no attentionSlaHours configured", async () => {
    const tenant = makeTenant({ attentionSlaHours: undefined });
    const lead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z" });
    const leadStore = new InMemoryLeadStore([lead]);

    await alertStaleAttentionItems(leadStore, [tenant], now);

    const updated = await leadStore.getLeadById(tenant.id, lead.id);
    expect(updated?.attentionAlertedAt).toBeUndefined();
  });

  it("skips a lead that isn't stale yet", async () => {
    const tenant = makeTenant({ attentionSlaHours: 48 }); // 24h-old lead, 48h SLA — not due yet
    const lead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z" });
    const leadStore = new InMemoryLeadStore([lead]);

    await alertStaleAttentionItems(leadStore, [tenant], now);

    const updated = await leadStore.getLeadById(tenant.id, lead.id);
    expect(updated?.attentionAlertedAt).toBeUndefined();
  });

  it("one tenant's getAllLeads failure doesn't stop other tenants from being alerted", async () => {
    const failingTenant = makeTenant({ id: "tenant-fail" });
    const okTenant = makeTenant({ id: "tenant-ok" });
    const okLead = makeLead({ tenantId: "tenant-ok", needsAttentionAt: "2026-01-01T00:00:00.000Z" });
    const realStore = new InMemoryLeadStore([okLead]);
    const leadStore: LeadStore = {
      getAllLeads: async (tenantId: string) => {
        if (tenantId === "tenant-fail") throw new Error("simulated DB error");
        return realStore.getAllLeads(tenantId);
      },
      getLeadById: realStore.getLeadById.bind(realStore),
      findLeadByContact: realStore.findLeadByContact.bind(realStore),
      createLead: realStore.createLead.bind(realStore),
      updateLead: realStore.updateLead.bind(realStore),
      deleteLead: realStore.deleteLead.bind(realStore),
    };

    await alertStaleAttentionItems(leadStore, [failingTenant, okTenant], now);

    const updated = await realStore.getLeadById("tenant-ok", okLead.id);
    expect(updated?.attentionAlertedAt).toBeTruthy();
  });

  it(
    "regression: never stamps attentionAlertedAt against a lead whose needsAttentionAt changed " +
      "since the tenant's lead list was snapshotted (a reply/mark-handled, or a brand-new inbound " +
      "message, racing this exact tick) — stamping the stale snapshot would permanently suppress " +
      "the SLA alert for the genuinely new, separate occurrence",
    async () => {
      const tenant = makeTenant();
      // The snapshot alertStaleAttentionItems' own getAllLeads call would have returned —
      // stale enough to alert on, per the tenant's SLA.
      const staleSnapshotLead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z" });
      // The lead's actual current state by the time this lead's turn comes up in the
      // loop: already resolved and re-flagged with a brand-new timestamp — not stale yet.
      const freshCurrentLead = makeLead({ needsAttentionAt: "2026-01-01T23:50:00.000Z" });

      let updateLeadCalls = 0;
      const raceLeadStore: LeadStore = {
        getAllLeads: async () => [staleSnapshotLead],
        getLeadById: async () => freshCurrentLead,
        findLeadByContact: async () => undefined,
        createLead: async (l) => l,
        updateLead: async (_tenantId, _id, patch) => {
          updateLeadCalls++;
          return { ...freshCurrentLead, ...patch };
        },
        deleteLead: async () => true,
      };

      await alertStaleAttentionItems(raceLeadStore, [tenant], now);

      expect(updateLeadCalls).toBe(0);
    }
  );

  it("does not re-alert a lead that's already been alerted for its current occurrence", async () => {
    const tenant = makeTenant();
    const lead = makeLead({
      needsAttentionAt: "2026-01-01T00:00:00.000Z",
      attentionAlertedAt: "2026-01-01T13:00:00.000Z",
    });
    const leadStore = new InMemoryLeadStore([lead]);

    let updateCalls = 0;
    const originalUpdate = leadStore.updateLead.bind(leadStore);
    leadStore.updateLead = async (...args) => {
      updateCalls++;
      return originalUpdate(...args);
    };

    await alertStaleAttentionItems(leadStore, [tenant], now);
    expect(updateCalls).toBe(0);
  });
});
