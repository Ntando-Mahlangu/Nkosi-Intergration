import { describe, expect, it } from "vitest";
import { InMemoryLeadStore } from "../src/store/leadStore.js";
import { buildRecoveryPlans, runRecoveryWorkflow } from "../src/workflow.js";
import type { Lead } from "../src/types.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

const LEADS: Lead[] = [
  {
    id: "recoverable-1",
    name: "Amara Ncube",
    phone: "+27821111111",
    source: "missed_call",
    createdAt: new Date("2026-09-10T00:00:00.000Z").toISOString(),
    hadMissedCall: true,
    requestedService: "kitchen remodel",
    status: "new",
  },
  {
    id: "suppressed-1",
    name: "Do Not Contact Dan",
    phone: "+27822222222",
    source: "crm",
    createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    status: "do_not_contact",
  },
  {
    id: "no-contact-info",
    name: "No Info Nomvula",
    source: "crm",
    createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    requestedService: "fencing",
    status: "new",
  },
];

describe("buildRecoveryPlans", () => {
  it("excludes suppressed leads and leads with no usable channel", () => {
    const { plans, skipped } = buildRecoveryPlans(LEADS, {}, NOW);
    expect(plans).toHaveLength(1);
    expect(plans[0].lead.id).toBe("recoverable-1");
    expect(skipped.map((s) => s.lead.id).sort()).toEqual(["no-contact-info", "suppressed-1"]);
  });

  it("never produces a plan for a do_not_contact lead", () => {
    const { plans } = buildRecoveryPlans(LEADS, {}, NOW);
    expect(plans.some((p) => p.lead.status === "do_not_contact")).toBe(false);
  });
});

describe("runRecoveryWorkflow", () => {
  it("sends to contactable leads and updates their status in the store", async () => {
    const store = new InMemoryLeadStore(LEADS);
    const result = await runRecoveryWorkflow(store, { businessName: "Acme Co" }, NOW);

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].result.ok).toBe(true);

    const updated = await store.getAllLeads();
    const contacted = updated.find((l) => l.id === "recoverable-1");
    expect(contacted?.status).toBe("contacted_no_response");
    expect(contacted?.lastContactedAt).toBe(NOW.toISOString());

    const suppressed = updated.find((l) => l.id === "suppressed-1");
    expect(suppressed?.status).toBe("do_not_contact");
  });
});
