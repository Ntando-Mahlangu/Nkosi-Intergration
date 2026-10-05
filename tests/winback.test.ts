import { describe, expect, it } from "vitest";
import {
  composeWinBackMessage,
  DEFAULT_WIN_BACK_COOLDOWN_DAYS,
  getLeadsDueForWinBack,
  isDueForWinBack,
  winBackReason,
} from "../src/winback.js";
import type { Lead, Tenant } from "../src/types.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

const TENANT: Tenant = {
  id: "t1",
  name: "Acme Co",
  apiKey: "key",
  timezone: "UTC",
  channels: {},
  createdAt: NOW.toISOString(),
  winBackEnabled: true,
};

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86400000).toISOString();
}

function makeConvertedLead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1",
    tenantId: "t1",
    name: "Jordan",
    phone: "+27821234567",
    source: "crm",
    createdAt: daysAgo(400),
    status: "converted",
    convertedAt: daysAgo(DEFAULT_WIN_BACK_COOLDOWN_DAYS + 1),
    marketingOptIn: true,
    ...overrides,
  };
}

describe("isDueForWinBack", () => {
  it("is due once the cooldown since conversion has elapsed", () => {
    const lead = makeConvertedLead({});
    expect(isDueForWinBack(TENANT, lead, NOW)).toBe(true);
  });

  it("is not due before the cooldown has elapsed", () => {
    const lead = makeConvertedLead({ convertedAt: daysAgo(10) });
    expect(isDueForWinBack(TENANT, lead, NOW)).toBe(false);
  });

  it("uses lastWinBackAt instead of convertedAt once one has already been sent", () => {
    const lead = makeConvertedLead({
      convertedAt: daysAgo(400),
      lastWinBackAt: daysAgo(10),
    });
    expect(isDueForWinBack(TENANT, lead, NOW)).toBe(false);
  });

  it("respects a tenant's own cooldown override", () => {
    const tenant = { ...TENANT, winBackCooldownDays: 30 };
    const lead = makeConvertedLead({ convertedAt: daysAgo(31) });
    expect(isDueForWinBack(tenant, lead, NOW)).toBe(true);
    expect(isDueForWinBack(tenant, makeConvertedLead({ convertedAt: daysAgo(10) }), NOW)).toBe(false);
  });

  it("never applies when the tenant hasn't turned win-back on", () => {
    const lead = makeConvertedLead({});
    expect(isDueForWinBack({ ...TENANT, winBackEnabled: false }, lead, NOW)).toBe(false);
  });

  it("never applies without this lead's own marketingOptIn, even with the feature on", () => {
    const lead = makeConvertedLead({ marketingOptIn: false });
    expect(isDueForWinBack(TENANT, lead, NOW)).toBe(false);
  });

  it("never applies to a lead that hasn't converted", () => {
    const lead = makeConvertedLead({ status: "contacted_no_response", convertedAt: undefined });
    expect(isDueForWinBack(TENANT, lead, NOW)).toBe(false);
  });

  it("stops immediately once a converted, opted-in lead's status changes away (e.g. a STOP reply)", () => {
    const lead = makeConvertedLead({ status: "opted_out" });
    expect(isDueForWinBack(TENANT, lead, NOW)).toBe(false);
  });
});

describe("getLeadsDueForWinBack", () => {
  it("filters a mixed list down to just the due leads", () => {
    const due = makeConvertedLead({ id: "due" });
    const notDue = makeConvertedLead({ id: "not-due", convertedAt: daysAgo(1) });
    const notOptedIn = makeConvertedLead({ id: "not-opted-in", marketingOptIn: false });
    expect(getLeadsDueForWinBack(TENANT, [due, notDue, notOptedIn], NOW).map((l) => l.id)).toEqual(["due"]);
  });
});

describe("composeWinBackMessage", () => {
  it("includes the lead's requested service when known", () => {
    const lead = makeConvertedLead({ requestedService: "kitchen renovation" });
    const message = composeWinBackMessage(lead, "sms", TENANT);
    expect(message.body).toContain("kitchen renovation");
    expect(message.body).toContain("Jordan");
    expect(message.body).toMatch(/STOP/);
  });

  it("falls back to a neutral check-in with no requested service on file", () => {
    const lead = makeConvertedLead({ requestedService: undefined });
    const message = composeWinBackMessage(lead, "sms", TENANT);
    expect(message.body).not.toContain("undefined");
    expect(message.body).toContain("Jordan");
  });

  it("uses a tenant's custom win-back template when set", () => {
    const lead = makeConvertedLead({});
    const tenant = { ...TENANT, templates: { winBack: "Hey {name}, from {businessName} — miss you!" } };
    const message = composeWinBackMessage(lead, "sms", tenant);
    expect(message.body).toBe("Hey Jordan, from Acme Co — miss you!");
  });
});

describe("winBackReason", () => {
  it("is grounded", () => {
    expect(winBackReason().grounded).toBe(true);
  });
});
