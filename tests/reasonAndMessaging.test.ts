import { describe, expect, it } from "vitest";
import { determineContactReason } from "../src/reason.js";
import { composeInitialMessage } from "../src/messaging.js";
import type { Lead } from "../src/types.js";

function makeLead(overrides: Partial<Lead>): Lead {
  return {
    id: "test-lead",
    name: "Jordan Smith",
    source: "crm",
    createdAt: new Date().toISOString(),
    status: "new",
    ...overrides,
  };
}

describe("determineContactReason", () => {
  it("grounds the reason in a previous quote when known", () => {
    const reason = determineContactReason(makeLead({ previousQuote: "R5,000" }));
    expect(reason.grounded).toBe(true);
    expect(reason.text).toMatch(/quote/i);
  });

  it("grounds the reason in a missed call when known", () => {
    const reason = determineContactReason(makeLead({ hadMissedCall: true }));
    expect(reason.grounded).toBe(true);
    expect(reason.text).toMatch(/missed your call/i);
  });

  it("falls back to ungrounded when nothing is known", () => {
    const reason = determineContactReason(makeLead({}));
    expect(reason.grounded).toBe(false);
    expect(reason.text).toBeUndefined();
  });

  it("never fabricates an event that isn't in the lead data", () => {
    // A lead with only a name/source and no interaction history must never
    // get a message claiming a quote, call, or conversation happened.
    const reason = determineContactReason(makeLead({}));
    expect(reason.grounded).toBe(false);
  });
});

describe("composeInitialMessage", () => {
  it("uses the grounded reason and includes an opt-out", () => {
    const lead = makeLead({ previousQuote: "R5,000" });
    const reason = determineContactReason(lead);
    const message = composeInitialMessage(lead, reason, "sms", { businessName: "Acme Co" });
    expect(message.body).toContain("Jordan");
    expect(message.body).toContain("Acme Co");
    expect(message.body).toMatch(/quote/i);
    expect(message.body).toMatch(/STOP/);
  });

  it("uses a neutral reactivation message when reason is ungrounded", () => {
    const lead = makeLead({ requestedService: "landscaping" });
    const reason = determineContactReason(lead); // grounded via requestedService
    const ungrounded = { grounded: false } as const;
    const message = composeInitialMessage(lead, ungrounded, "email", { businessName: "Acme Co" });
    expect(message.body).not.toMatch(/we noticed we missed your call/i);
    expect(message.body).toMatch(/check back in/i);
    expect(message.body).toMatch(/landscaping/i);
    expect(reason.grounded).toBe(true); // sanity: requestedService alone is grounded
  });

  it("never claims a specific event for a fully unknown lead", () => {
    const lead = makeLead({});
    const reason = determineContactReason(lead);
    const message = composeInitialMessage(lead, reason, "email", { businessName: "Acme Co" });
    expect(message.body).not.toMatch(/quote|missed your call|previously spoke/i);
  });
});
