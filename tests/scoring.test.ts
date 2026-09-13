import { describe, expect, it } from "vitest";
import { scoreLead, sortByPriority } from "../src/scoring.js";
import type { Lead } from "../src/types.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

function makeLead(overrides: Partial<Lead>): Lead {
  return {
    id: "test-lead",
    tenantId: "test-tenant",
    source: "crm",
    createdAt: NOW.toISOString(),
    status: "new",
    ...overrides,
  };
}

describe("scoreLead", () => {
  it("scores a recent missed call as HIGH", () => {
    const lead = makeLead({
      hadMissedCall: true,
      createdAt: new Date("2026-09-10T00:00:00.000Z").toISOString(),
    });
    const { priority, priorityReasons } = scoreLead(lead, NOW);
    expect(priority).toBe("HIGH");
    expect(priorityReasons).toContain("Recent missed call");
  });

  it("scores a recent quote request as HIGH", () => {
    const lead = makeLead({
      previousQuote: "R10,000",
      createdAt: new Date("2026-09-11T00:00:00.000Z").toISOString(),
    });
    expect(scoreLead(lead, NOW).priority).toBe("HIGH");
  });

  it("scores an explicit appointment request as HIGH regardless of age", () => {
    const lead = makeLead({
      appointmentStatus: "requested",
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    });
    expect(scoreLead(lead, NOW).priority).toBe("HIGH");
  });

  it("scores a contacted-no-response lead as MEDIUM", () => {
    const lead = makeLead({
      status: "contacted_no_response",
      requestedService: "fence installation",
      createdAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    });
    expect(scoreLead(lead, NOW).priority).toBe("MEDIUM");
  });

  it("scores a very old lead with no history as LOW", () => {
    const lead = makeLead({ createdAt: new Date("2025-01-01T00:00:00.000Z").toISOString() });
    const { priority, priorityReasons } = scoreLead(lead, NOW);
    expect(priority).toBe("LOW");
    expect(priorityReasons).toContain("Very old lead");
    expect(priorityReasons).toContain("No meaningful interaction history");
  });

  it("sorts HIGH before MEDIUM before LOW", () => {
    const high = scoreLead(makeLead({ hadMissedCall: true }), NOW);
    const medium = scoreLead(
      makeLead({ status: "contacted_no_response", requestedService: "paint" }),
      NOW
    );
    const low = scoreLead(makeLead({ createdAt: new Date("2025-01-01").toISOString() }), NOW);

    const sorted = sortByPriority([low, high, medium]);
    expect(sorted.map((s) => s.priority)).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });
});
