import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_RETENTION_DAYS, isPastRetention, retentionDaysFor } from "../src/dataRetention.js";
import type { Lead } from "../src/types.js";

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    tenantId: "tenant-1",
    source: "crm",
    createdAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
    status: "converted",
    ...overrides,
  };
}

describe("retentionDaysFor", () => {
  it("falls back to the system default when the tenant hasn't set an override", () => {
    expect(retentionDaysFor({})).toBe(DEFAULT_DATA_RETENTION_DAYS);
  });

  it("uses the tenant's own override when set", () => {
    expect(retentionDaysFor({ dataRetentionDays: 90 })).toBe(90);
  });
});

describe("isPastRetention", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it.each(["new", "contacted_no_response", "responded", "booked", "active_conversation"] as const)(
    "never purges an active-pipeline lead (status=%s) regardless of age",
    (status) => {
      const lead = makeLead({ status, createdAt: new Date("2000-01-01").toISOString() });
      expect(isPastRetention(lead, 30, now)).toBe(false);
    }
  );

  it.each(["do_not_contact", "opted_out"] as const)(
    "never purges a suppressed lead (status=%s) regardless of age — purging it would let a later re-import re-contact them with no memory of the opt-out",
    (status) => {
      const lead = makeLead({ status, createdAt: new Date("2000-01-01").toISOString() });
      expect(isPastRetention(lead, 30, now)).toBe(false);
    }
  );

  it.each(["unqualified", "fraudulent", "converted"] as const)(
    "purges a closed-out lead (status=%s) once past the retention window",
    (status) => {
      const lead = makeLead({
        status,
        createdAt: new Date("2000-01-01").toISOString(),
        lastContactedAt: new Date("2025-01-01").toISOString(),
      });
      expect(isPastRetention(lead, 300, now)).toBe(true); // ~365 days since lastContactedAt
      expect(isPastRetention(lead, 400, now)).toBe(false); // not yet past a longer window
    }
  );

  it("ages off lastContactedAt when set, ignoring the older createdAt", () => {
    const lead = makeLead({
      createdAt: new Date("2000-01-01").toISOString(),
      lastContactedAt: new Date("2025-12-31").toISOString(), // 1 day before `now`
    });
    expect(isPastRetention(lead, 30, now)).toBe(false);
  });

  it("falls back to createdAt when a lead was never actually contacted", () => {
    const lead = makeLead({ createdAt: new Date("2025-12-31").toISOString(), lastContactedAt: undefined });
    expect(isPastRetention(lead, 30, now)).toBe(false);
    expect(isPastRetention(lead, 1, now)).toBe(true);
  });

  it("is exactly boundary-inclusive at retentionDays", () => {
    const lead = makeLead({ lastContactedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString() });
    expect(isPastRetention(lead, 30, now)).toBe(true);
    expect(isPastRetention(lead, 31, now)).toBe(false);
  });

  it(
    "regression: a converted lead still getting win-back check-ins doesn't age off its frozen " +
      "lastContactedAt — sendWinBackPlans (workflow.ts) never touches lastContactedAt, so without " +
      "considering lastWinBackAt here, an actively-managed customer relationship (with marketingOptIn " +
      "consent on file) would get purged, destroying that consent record",
    () => {
      const lead = makeLead({
        status: "converted",
        createdAt: new Date("2020-01-01").toISOString(),
        lastContactedAt: new Date("2020-06-01").toISOString(), // frozen at original conversion
        lastWinBackAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), // a win-back sent 10 days ago
      });
      // Past 365 days since lastContactedAt alone, but win-back activity is recent.
      expect(isPastRetention(lead, 365, now)).toBe(false);
    }
  );

  it("still purges a converted lead whose win-back activity has also gone cold", () => {
    const lead = makeLead({
      status: "converted",
      createdAt: new Date("2000-01-01").toISOString(),
      lastContactedAt: new Date("2000-01-01").toISOString(),
      lastWinBackAt: new Date("2000-06-01").toISOString(), // also long past the retention window
    });
    expect(isPastRetention(lead, 365, now)).toBe(true);
  });
});
