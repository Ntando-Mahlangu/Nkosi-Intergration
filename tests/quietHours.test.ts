import { describe, expect, it } from "vitest";
import { isWithinQuietHours, parseQuietHour } from "../src/quietHours.js";
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

  it("a NaN quiet-hours window (what an unvalidated bad input used to produce) silently disables quiet hours entirely", () => {
    // Documents the exact failure mode parseQuietHour below now prevents:
    // Number("8pm") is NaN, and every comparison against NaN is false, so
    // isWithinQuietHours returns false for every hour of every day with no
    // error ever surfaced — see src/scripts/onboardTenant.ts.
    const tenant = makeTenant({ quietHours: { startHour: NaN, endHour: NaN } });
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T03:00:00.000Z"))).toBe(false);
    expect(isWithinQuietHours(tenant, new Date("2026-09-12T12:00:00.000Z"))).toBe(false);
  });
});

describe("parseQuietHour", () => {
  it("parses a valid hour string", () => {
    expect(parseQuietHour("20", "Quiet hours start")).toBe(20);
    expect(parseQuietHour("0", "Quiet hours end")).toBe(0);
    expect(parseQuietHour("23", "Quiet hours end")).toBe(23);
  });

  it("rejects non-numeric input instead of silently producing NaN", () => {
    // Regression test: this exact input used to be stored as-is via
    // Number("8pm") === NaN in src/scripts/onboardTenant.ts, silently
    // disabling quiet-hours protection for that tenant forever.
    expect(() => parseQuietHour("8pm", "Quiet hours start")).toThrow(/whole number from 0 to 23/);
  });

  it("rejects out-of-range and non-integer input", () => {
    expect(() => parseQuietHour("24", "Quiet hours start")).toThrow();
    expect(() => parseQuietHour("-1", "Quiet hours start")).toThrow();
    expect(() => parseQuietHour("9.5", "Quiet hours start")).toThrow();
  });

  it("rejects blank input instead of silently treating it as hour 0", () => {
    // Number("") is 0, a valid hour — without an explicit blank check this
    // would silently succeed instead of surfacing a validation error.
    expect(() => parseQuietHour("", "Quiet hours start")).toThrow();
    expect(() => parseQuietHour("   ", "Quiet hours start")).toThrow();
  });
});
