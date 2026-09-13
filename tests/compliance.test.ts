import { describe, expect, it } from "vitest";
import { checkSuppression, isContactable } from "../src/compliance.js";
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
});
