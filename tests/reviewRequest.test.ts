import { describe, expect, it } from "vitest";
import {
  composeReviewRequestMessage,
  DEFAULT_REVIEW_REQUEST_DELAY_DAYS,
  getLeadsDueForReviewRequest,
  isDueForReviewRequest,
  reviewRequestReason,
} from "../src/reviewRequest.js";
import type { Lead, Tenant } from "../src/types.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

const TENANT: Tenant = {
  id: "t1",
  name: "Acme Co",
  apiKey: "key",
  timezone: "UTC",
  channels: {},
  createdAt: NOW.toISOString(),
  reviewRequestEnabled: true,
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
    convertedAt: daysAgo(DEFAULT_REVIEW_REQUEST_DELAY_DAYS + 1),
    marketingOptIn: true,
    ...overrides,
  };
}

describe("isDueForReviewRequest", () => {
  it("is due once the delay since conversion has elapsed", () => {
    const lead = makeConvertedLead({});
    expect(isDueForReviewRequest(TENANT, lead, NOW)).toBe(true);
  });

  it("is not due before the delay has elapsed", () => {
    const lead = makeConvertedLead({ convertedAt: daysAgo(1) });
    expect(isDueForReviewRequest(TENANT, lead, NOW)).toBe(false);
  });

  it("is due immediately (delay 0) for a tenant that wants it sent the moment a lead converts", () => {
    const tenant = { ...TENANT, reviewRequestDelayDays: 0 };
    const lead = makeConvertedLead({ convertedAt: NOW.toISOString() });
    expect(isDueForReviewRequest(tenant, lead, NOW)).toBe(true);
  });

  it("never applies once it's already been sent — this never repeats, unlike win-back", () => {
    const lead = makeConvertedLead({ reviewRequestSentAt: daysAgo(1) });
    expect(isDueForReviewRequest(TENANT, lead, NOW)).toBe(false);
  });

  it("respects a tenant's own delay override", () => {
    const tenant = { ...TENANT, reviewRequestDelayDays: 10 };
    expect(isDueForReviewRequest(tenant, makeConvertedLead({ convertedAt: daysAgo(11) }), NOW)).toBe(true);
    expect(isDueForReviewRequest(tenant, makeConvertedLead({ convertedAt: daysAgo(5) }), NOW)).toBe(false);
  });

  it("never applies when the tenant hasn't turned review requests on", () => {
    const lead = makeConvertedLead({});
    expect(isDueForReviewRequest({ ...TENANT, reviewRequestEnabled: false }, lead, NOW)).toBe(false);
  });

  it("never applies without this lead's own marketingOptIn, even with the feature on", () => {
    const lead = makeConvertedLead({ marketingOptIn: false });
    expect(isDueForReviewRequest(TENANT, lead, NOW)).toBe(false);
  });

  it("never applies to a lead that hasn't converted", () => {
    const lead = makeConvertedLead({ status: "contacted_no_response", convertedAt: undefined });
    expect(isDueForReviewRequest(TENANT, lead, NOW)).toBe(false);
  });

  it("stops immediately once a converted, opted-in lead's status changes away (e.g. a STOP reply)", () => {
    const lead = makeConvertedLead({ status: "opted_out" });
    expect(isDueForReviewRequest(TENANT, lead, NOW)).toBe(false);
  });
});

describe("getLeadsDueForReviewRequest", () => {
  it("filters a mixed list down to just the due leads", () => {
    const due = makeConvertedLead({ id: "due" });
    const alreadySent = makeConvertedLead({ id: "already-sent", reviewRequestSentAt: daysAgo(1) });
    const notOptedIn = makeConvertedLead({ id: "not-opted-in", marketingOptIn: false });
    expect(getLeadsDueForReviewRequest(TENANT, [due, alreadySent, notOptedIn], NOW).map((l) => l.id)).toEqual(["due"]);
  });
});

describe("composeReviewRequestMessage", () => {
  it("includes the lead's requested service when known", () => {
    const lead = makeConvertedLead({ requestedService: "kitchen renovation" });
    const message = composeReviewRequestMessage(lead, "sms", TENANT);
    expect(message.body).toContain("kitchen renovation");
    expect(message.body).toContain("Jordan");
    expect(message.body).toMatch(/STOP/);
  });

  it("falls back to a neutral thank-you with no requested service on file", () => {
    const lead = makeConvertedLead({ requestedService: undefined });
    const message = composeReviewRequestMessage(lead, "sms", TENANT);
    expect(message.body).not.toContain("undefined");
    expect(message.body).toContain("Jordan");
  });

  it("uses a tenant's custom review-request template when set", () => {
    const lead = makeConvertedLead({});
    const tenant = { ...TENANT, templates: { reviewRequest: "Hey {name}, loved working with {businessName}?" } };
    const message = composeReviewRequestMessage(lead, "sms", tenant);
    expect(message.body).toBe("Hey Jordan, loved working with Acme Co?");
  });
});

describe("reviewRequestReason", () => {
  it("is grounded", () => {
    expect(reviewRequestReason().grounded).toBe(true);
  });
});
