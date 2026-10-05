import { describe, expect, it } from "vitest";
import { isStaleAttentionItem } from "../src/attentionSla.js";
import type { Lead } from "../src/types.js";

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

describe("isStaleAttentionItem", () => {
  const now = new Date("2026-01-02T00:00:00.000Z"); // 24h after needsAttentionAt below

  it("is false when the tenant has no attentionSlaHours configured (opt-in)", () => {
    const lead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z" });
    expect(isStaleAttentionItem(lead, {}, now)).toBe(false);
  });

  it("is false when the lead isn't flagged at all", () => {
    const lead = makeLead();
    expect(isStaleAttentionItem(lead, { attentionSlaHours: 12 }, now)).toBe(false);
  });

  it("is false when flagged but still within the SLA window", () => {
    const lead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z" }); // 24h old
    expect(isStaleAttentionItem(lead, { attentionSlaHours: 48 }, now)).toBe(false);
  });

  it("is true once past the SLA window", () => {
    const lead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z" }); // 24h old
    expect(isStaleAttentionItem(lead, { attentionSlaHours: 12 }, now)).toBe(true);
  });

  it("is true exactly at the SLA boundary", () => {
    const lead = makeLead({ needsAttentionAt: "2026-01-01T00:00:00.000Z" }); // exactly 24h old
    expect(isStaleAttentionItem(lead, { attentionSlaHours: 24 }, now)).toBe(true);
  });

  it("is false once already alerted for this unresolved item, even if still past SLA", () => {
    const lead = makeLead({
      needsAttentionAt: "2026-01-01T00:00:00.000Z",
      attentionAlertedAt: "2026-01-01T13:00:00.000Z",
    });
    expect(isStaleAttentionItem(lead, { attentionSlaHours: 12 }, now)).toBe(false);
  });
});
