import { describe, expect, it } from "vitest";
import { isWithinQuietHours } from "../src/quietHours.js";
import type { Tenant } from "../src/types.js";

function makeTenant(overrides: Partial<Tenant>): Tenant {
  return {
    id: "t1",
    name: "Acme",
    apiKey: "key",
    timezone: "UTC",
    channels: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("isWithinQuietHours", () => {
  it("uses the 8pm-8am default when a tenant hasn't configured quiet hours", () => {
    const tenant = makeTenant({});
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T22:00:00.000Z"))).toBe(true); // 10pm UTC
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T14:00:00.000Z"))).toBe(false); // 2pm UTC
  });

  it("respects an explicit wrapping window", () => {
    const tenant = makeTenant({ quietHours: { startHour: 21, endHour: 7 } });
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T23:00:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T06:00:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T12:00:00.000Z"))).toBe(false);
  });

  it("respects a non-wrapping window", () => {
    const tenant = makeTenant({ quietHours: { startHour: 9, endHour: 17 } });
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T12:00:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T20:00:00.000Z"))).toBe(false);
  });

  it("disables quiet hours entirely with a zero-width window", () => {
    const tenant = makeTenant({ quietHours: { startHour: 5, endHour: 5 } });
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T05:00:00.000Z"))).toBe(false);
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T23:00:00.000Z"))).toBe(false);
  });

  it("evaluates the window in the tenant's own timezone, not UTC", () => {
    // Africa/Johannesburg is UTC+2 with no DST, so 19:30 UTC is 21:30 local -> inside default 8pm-8am quiet hours.
    const tenant = makeTenant({ timezone: "Africa/Johannesburg" });
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T19:30:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T09:30:00.000Z"))).toBe(false); // 11:30 local
  });
});
