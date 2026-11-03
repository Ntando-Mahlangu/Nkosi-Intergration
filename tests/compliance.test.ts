import { describe, expect, it } from "vitest";
import { checkSuppression, hardStopReason, isContactable, isHardStopped } from "../src/compliance.js";
import type { Lead } from "../src/types.js";

function makeLead(overrides: Partial<Lead>): Lead {
  return {
    id: "test-lead",
    tenantId: "test-tenant",
    source: "crm",
    createdAt: new Date().toISOString(),
    status: "new",
    ...overrides,
  };
}

describe("compliance", () => {
  it("allows contacting a new lead", () => {
    const lead = makeLead({ status: "new" });
    expect(isContactable(lead)).toBe(true);
    expect(checkSuppression(lead).suppressed).toBe(false);
  });

  it.each([
    "do_not_contact",
    "unqualified",
    "fraudulent",
    "active_conversation",
    "booked",
    "converted",
    "opted_out",
  ] as const)("suppresses leads with status=%s", (status) => {
    const lead = makeLead({ status });
    const check = checkSuppression(lead);
    expect(check.suppressed).toBe(true);
    expect(check.reason).toBeTruthy();
    expect(isContactable(lead)).toBe(false);
  });

  it("suppresses a lead with an explicitly withdrawn consent, even with an otherwise-contactable status", () => {
    const lead = makeLead({ status: "new", consentStatus: "withdrawn" });
    const check = checkSuppression(lead);
    expect(check.suppressed).toBe(true);
    expect(check.reason).toBe("consent withdrawn");
    expect(isContactable(lead)).toBe(false);
    expect(isHardStopped(lead)).toBe(true);
    expect(hardStopReason(lead)).toBe("consent withdrawn");
  });

  it.each(["unknown", "granted", undefined] as const)(
    "does not suppress a lead whose consentStatus is %s — unknown is never treated as granted, but it's also not newly blocked",
    (consentStatus) => {
      const lead = makeLead({ status: "new", consentStatus });
      expect(checkSuppression(lead).suppressed).toBe(false);
      expect(isContactable(lead)).toBe(true);
      expect(isHardStopped(lead)).toBe(false);
    }
  );
});
