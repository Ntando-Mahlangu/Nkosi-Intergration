import { describe, expect, it } from "vitest";
import { composeFollowUpMessage, FOLLOWUP_INTERVAL_DAYS, getLeadsDueForFollowUp, isDueForFollowUp } from "../src/followup.js";
import type { Lead, Tenant } from "../src/types.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

const TENANT: Tenant = {
  id: "t1",
  name: "Acme Co",
  apiKey: "key",
  timezone: "UTC",
  channels: {},
  createdAt: NOW.toISOString(),
};

function makeContactedLead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1",
    tenantId: "t1",
    name: "Jordan",
    phone: "+27821234567",
    source: "crm",
    createdAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    status: "contacted_no_response",
    firstOutreachSentAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    lastContactedAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    followUpCount: 0,
    ...overrides,
  };
}

describe("isDueForFollowUp", () => {
  it("is not due before the first interval has elapsed", () => {
    const lead = makeContactedLead({ lastContactedAt: new Date("2026-09-11T00:00:00.000Z").toISOString() });
    expect(isDueForFollowUp(lead, NOW)).toBe(false);
  });

  it("is due once the interval for the current follow-up count has elapsed", () => {
    const lead = makeContactedLead({
      lastContactedAt: new Date(NOW.getTime() - FOLLOWUP_INTERVAL_DAYS[0] * 86400000).toISOString(),
    });
    expect(isDueForFollowUp(lead, NOW)).toBe(true);
  });

  it("never follows up on a lead LeadRecovery itself never contacted", () => {
    const lead = makeContactedLead({ firstOutreachSentAt: undefined });
    expect(isDueForFollowUp(lead, NOW)).toBe(false);
  });

  it("stops after the max number of follow-ups", () => {
    const lead = makeContactedLead({
      followUpCount: FOLLOWUP_INTERVAL_DAYS.length,
      lastContactedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    });
    expect(isDueForFollowUp(lead, NOW)).toBe(false);
  });

  it("stops immediately once the lead has replied", () => {
    const lead = makeContactedLead({
      status: "responded",
      lastContactedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    });
    expect(isDueForFollowUp(lead, NOW)).toBe(false);
  });

  it("stops immediately once the lead has opted out", () => {
    const lead = makeContactedLead({
      status: "opted_out",
      lastContactedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    });
    expect(isDueForFollowUp(lead, NOW)).toBe(false);
  });
});

describe("getLeadsDueForFollowUp", () => {
  it("filters a mixed list down to just the due leads", () => {
    const due = makeContactedLead({
      id: "due",
      lastContactedAt: new Date(NOW.getTime() - 30 * 86400000).toISOString(),
    });
    const notDue = makeContactedLead({ id: "not-due", lastContactedAt: NOW.toISOString() });
    expect(getLeadsDueForFollowUp([due, notDue], NOW).map((l) => l.id)).toEqual(["due"]);
  });
});

describe("composeFollowUpMessage", () => {
  it("uses distinct wording for each successive follow-up", () => {
    const lead = makeContactedLead({});
    const bodies = [0, 1, 2].map((i) => composeFollowUpMessage(lead, i, "sms", TENANT).body);
    expect(new Set(bodies).size).toBe(3);
    for (const body of bodies) {
      expect(body).toMatch(/STOP/);
      expect(body).toContain("Jordan");
    }
  });

  it("uses a tenant's custom follow-up templates when set", () => {
    const lead = makeContactedLead({});
    const tenant = { ...TENANT, templates: { followUps: ["Nudge 1 for {name} from {businessName}."] } };
    const message = composeFollowUpMessage(lead, 0, "sms", tenant);
    expect(message.body).toBe("Nudge 1 for Jordan from Acme Co.");
  });
});
