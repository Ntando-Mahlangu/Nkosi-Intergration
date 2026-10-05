import { describe, expect, it } from "vitest";
import { parseCsv, parseLeadsCsv, createLeadsDeduped } from "../src/leadImport.js";
import { InMemoryLeadStore } from "../src/store/memory.js";
import type { Lead } from "../src/types.js";

describe("parseCsv", () => {
  it("parses a simple comma-separated file", () => {
    const rows = parseCsv("name,phone\nJordan,+27821234567\n");
    expect(rows).toEqual([
      ["name", "phone"],
      ["Jordan", "+27821234567"],
    ]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const rows = parseCsv('name,notes\nJordan,"Likes ""quotes"", and commas, too"\n');
    expect(rows[1]).toEqual(["Jordan", 'Likes "quotes", and commas, too']);
  });

  it("handles CRLF and LF line endings interchangeably", () => {
    const rows = parseCsv("a,b\r\n1,2\n3,4\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("parseLeadsCsv", () => {
  const TENANT_ID = "tenant-1";

  it("maps known columns onto Lead fields, case-insensitively", () => {
    const csv =
      "Name,Phone,Email,Source,RequestedService,PreviousQuote,Notes\n" +
      "Jordan Smith,+27821234567,jordan@example.com,website_form,fencing,R5000,call after 5pm\n";
    const { leads, skippedCount } = parseLeadsCsv(csv, TENANT_ID);
    expect(skippedCount).toBe(0);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      tenantId: TENANT_ID,
      name: "Jordan Smith",
      phone: "+27821234567",
      email: "jordan@example.com",
      source: "website_form",
      requestedService: "fencing",
      previousQuote: "R5000",
      notes: "call after 5pm",
      status: "new",
    });
    expect(leads[0].id).toMatch(/^lead_/);
  });

  it("skips a row with neither phone nor email, counting it separately from imported leads", () => {
    const csv = "name,phone,email\nNo Contact Info,,\nHas Phone,+27821234567,\n";
    const { leads, skippedCount } = parseLeadsCsv(csv, TENANT_ID);
    expect(leads).toHaveLength(1);
    expect(leads[0].name).toBe("Has Phone");
    expect(skippedCount).toBe(1);
  });

  it("falls back to 'spreadsheet' for a missing or unrecognized source, rather than storing arbitrary text", () => {
    const csv = "phone,source\n+27821111111,\n+27822222222,not-a-real-source\n+27823333333,crm\n";
    const { leads } = parseLeadsCsv(csv, TENANT_ID);
    expect(leads.map((l) => l.source)).toEqual(["spreadsheet", "spreadsheet", "crm"]);
  });

  it("parses a valid appointmentAt and sets appointmentStatus to booked", () => {
    const csv = "phone,appointmentAt\n+27821111111,2026-10-01T10:00:00Z\n";
    const { leads } = parseLeadsCsv(csv, TENANT_ID);
    expect(leads[0].appointmentAt).toBe("2026-10-01T10:00:00.000Z");
    expect(leads[0].appointmentStatus).toBe("booked");
  });

  it("ignores an unparseable appointmentAt rather than storing garbage", () => {
    const csv = "phone,appointmentAt\n+27821111111,not-a-date\n";
    const { leads } = parseLeadsCsv(csv, TENANT_ID);
    expect(leads[0].appointmentAt).toBeUndefined();
    expect(leads[0].appointmentStatus).toBeUndefined();
  });

  it("defaults createdAt to now when the column is absent", () => {
    const csv = "phone\n+27821111111\n";
    const before = Date.now();
    const { leads } = parseLeadsCsv(csv, TENANT_ID);
    expect(Date.parse(leads[0].createdAt)).toBeGreaterThanOrEqual(before);
  });

  it("normalizes a valid createdAt to ISO", () => {
    const csv = "phone,createdAt\n+27821111111,2024-01-15T00:00:00Z\n";
    const { leads } = parseLeadsCsv(csv, TENANT_ID);
    expect(leads[0].createdAt).toBe("2024-01-15T00:00:00.000Z");
  });

  it("falls back to now (not a NaN-producing raw string) for an unparseable createdAt", () => {
    // Regression test: storing the raw CSV cell verbatim (e.g. "TBD", a bad
    // locale format) made scoring.ts's daysSince() compute NaN, silently
    // disabling every age-gated priority rule for that lead — it always
    // fell through to the lowest generic priority regardless of its real
    // signals (a fresh missed call, a recent quote).
    const csv = "phone,createdAt\n+27821111111,TBD\n";
    const before = Date.now();
    const { leads } = parseLeadsCsv(csv, TENANT_ID);
    expect(Date.parse(leads[0].createdAt)).toBeGreaterThanOrEqual(before);
  });

  it("returns nothing for an empty file", () => {
    expect(parseLeadsCsv("", TENANT_ID)).toEqual({ leads: [], skippedCount: 0 });
  });
});

describe("createLeadsDeduped", () => {
  const TENANT_ID = "tenant-1";

  function makeLead(overrides: Partial<Lead>): Lead {
    return {
      id: `lead-${Math.random()}`,
      tenantId: TENANT_ID,
      source: "spreadsheet",
      createdAt: new Date().toISOString(),
      status: "new",
      ...overrides,
    };
  }

  it("creates every lead when none overlap an existing one or each other", async () => {
    const store = new InMemoryLeadStore([]);
    const leads = [makeLead({ phone: "+27821111111" }), makeLead({ email: "b@example.com" })];
    const result = await createLeadsDeduped(store, TENANT_ID, leads);
    expect(result).toEqual({ imported: 2, duplicates: 0 });
    expect(await store.getAllLeads(TENANT_ID)).toHaveLength(2);
  });

  it("skips a row whose phone already matches an existing lead, without touching the existing one", async () => {
    const existing = makeLead({ id: "existing-1", phone: "+27821111111", name: "Original Name" });
    const store = new InMemoryLeadStore([existing]);
    const result = await createLeadsDeduped(store, TENANT_ID, [
      makeLead({ phone: "+27821111111", name: "Re-imported Name" }),
    ]);
    expect(result).toEqual({ imported: 0, duplicates: 1 });
    const all = await store.getAllLeads(TENANT_ID);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Original Name"); // untouched, not merged/overwritten
  });

  it("skips a row whose email already matches an existing lead", async () => {
    const existing = makeLead({ id: "existing-1", email: "jordan@example.com" });
    const store = new InMemoryLeadStore([existing]);
    const result = await createLeadsDeduped(store, TENANT_ID, [makeLead({ email: "jordan@example.com" })]);
    expect(result).toEqual({ imported: 0, duplicates: 1 });
  });

  it("dedupes within the same batch, not just against already-stored leads", async () => {
    const store = new InMemoryLeadStore([]);
    const result = await createLeadsDeduped(store, TENANT_ID, [
      makeLead({ phone: "+27821111111", name: "First" }),
      makeLead({ phone: "+27821111111", name: "Second" }),
    ]);
    expect(result).toEqual({ imported: 1, duplicates: 1 });
    const all = await store.getAllLeads(TENANT_ID);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("First"); // first occurrence wins
  });

  it("only dedupes within this tenant — the same contact info for a different tenant doesn't count", async () => {
    const existing = makeLead({ id: "other-tenant-lead", tenantId: "tenant-2", phone: "+27821111111" });
    const store = new InMemoryLeadStore([existing]);
    const result = await createLeadsDeduped(store, TENANT_ID, [makeLead({ phone: "+27821111111" })]);
    expect(result).toEqual({ imported: 1, duplicates: 0 });
  });
});
