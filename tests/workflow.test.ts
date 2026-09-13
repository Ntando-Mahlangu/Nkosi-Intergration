import { describe, expect, it } from "vitest";
import { InMemoryLeadStore, InMemoryMessageStore } from "../src/store/memory.js";
import { buildRecoveryPlans, runRecoveryWorkflow } from "../src/workflow.js";
import type { Lead, Tenant } from "../src/types.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "test-key",
  timezone: "UTC",
  devMode: true, // console-fallback sends, no real Twilio/SendGrid credentials needed
  quietHours: { startHour: 0, endHour: 0 }, // disabled, so tests aren't sensitive to what time NOW happens to be
  channels: {},
  createdAt: NOW.toISOString(),
};

const LEADS: Lead[] = [
  {
    id: "recoverable-1",
    tenantId: TENANT.id,
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
    tenantId: TENANT.id,
    name: "Do Not Contact Dan",
    phone: "+27822222222",
    source: "crm",
    createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    status: "do_not_contact",
  },
  {
    id: "no-contact-info",
    tenantId: TENANT.id,
    name: "No Info Nomvula",
    source: "crm",
    createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    requestedService: "fencing",
    status: "new",
  },
];

describe("buildRecoveryPlans", () => {
  it("excludes suppressed leads and leads with no usable channel", () => {
    const { plans, skipped } = buildRecoveryPlans(TENANT, LEADS, NOW);
    expect(plans).toHaveLength(1);
    expect(plans[0].lead.id).toBe("recoverable-1");
    expect(skipped.map((s) => s.lead.id).sort()).toEqual(["no-contact-info", "suppressed-1"]);
  });

  it("never produces a plan for a do_not_contact lead", () => {
    const { plans } = buildRecoveryPlans(TENANT, LEADS, NOW);
    expect(plans.some((p) => p.lead.status === "do_not_contact")).toBe(false);
  });

  it("skips leads that already got their initial LeadRecovery outreach", () => {
    const alreadyContacted: Lead = {
      ...LEADS[0],
      id: "already-contacted",
      firstOutreachSentAt: NOW.toISOString(),
      status: "contacted_no_response",
    };
    const { plans, skipped } = buildRecoveryPlans(TENANT, [alreadyContacted], NOW);
    expect(plans).toHaveLength(0);
    expect(skipped).toHaveLength(0); // handled by the follow-up pass instead, not reported as skipped here
  });
});

describe("runRecoveryWorkflow", () => {
  it("sends to contactable leads and updates their status/firstOutreachSentAt in the store", async () => {
    const store = new InMemoryLeadStore(LEADS);
    const messages = new InMemoryMessageStore();
    const result = await runRecoveryWorkflow(TENANT, store, messages, NOW);

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].result.ok).toBe(true);
    expect(result.sent[0].isFollowUp).toBe(false);

    const updated = await store.getAllLeads(TENANT.id);
    const contacted = updated.find((l) => l.id === "recoverable-1");
    expect(contacted?.status).toBe("contacted_no_response");
    expect(contacted?.lastContactedAt).toBe(NOW.toISOString());
    expect(contacted?.firstOutreachSentAt).toBe(NOW.toISOString());
    expect(contacted?.followUpCount).toBe(0);

    const suppressed = updated.find((l) => l.id === "suppressed-1");
    expect(suppressed?.status).toBe("do_not_contact");

    const logged = await messages.getMessagesForLead(TENANT.id, "recoverable-1");
    expect(logged).toHaveLength(1);
    expect(logged[0].direction).toBe("outbound");
  });

  it("defers sends during tenant quiet hours instead of sending or mutating status", async () => {
    const quietTenant: Tenant = { ...TENANT, quietHours: { startHour: 0, endHour: 24 } };
    const store = new InMemoryLeadStore(LEADS);
    const result = await runRecoveryWorkflow(quietTenant, store, undefined, NOW);

    expect(result.sent).toHaveLength(0);
    expect(result.deferred.some((d) => d.lead.id === "recoverable-1")).toBe(true);

    const updated = await store.getAllLeads(TENANT.id);
    const untouched = updated.find((l) => l.id === "recoverable-1");
    expect(untouched?.status).toBe("new");
    expect(untouched?.firstOutreachSentAt).toBeUndefined();
  });

  it("sends a follow-up (not a duplicate initial message) to a lead already contacted once", async () => {
    const contactedLead: Lead = {
      id: "followup-lead",
      tenantId: TENANT.id,
      name: "Farai Moyo",
      phone: "+27821234099",
      source: "crm",
      createdAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
      status: "contacted_no_response",
      firstOutreachSentAt: new Date("2026-09-05T00:00:00.000Z").toISOString(),
      lastContactedAt: new Date("2026-09-05T00:00:00.000Z").toISOString(),
      followUpCount: 0,
    };
    const store = new InMemoryLeadStore([contactedLead]);
    const result = await runRecoveryWorkflow(TENANT, store, undefined, NOW);

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].isFollowUp).toBe(true);

    const updated = await store.getLeadById(TENANT.id, "followup-lead");
    expect(updated?.followUpCount).toBe(1);
  });
});
