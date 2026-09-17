import { describe, expect, it } from "vitest";
import { leadsToCsv } from "../src/csv.js";
import type { Lead } from "../src/types.js";

const LEAD: Lead = {
  id: "lead-1",
  tenantId: "tenant-1",
  name: "Jordan Smith",
  phone: "+27821234567",
  email: "jordan@example.com",
  source: "crm",
  createdAt: "2026-08-01T00:00:00.000Z",
  status: "contacted_no_response",
  requestedService: "fencing",
  followUpCount: 1,
  hadMissedCall: true,
};

describe("leadsToCsv", () => {
  it("includes a header row and one row per lead", () => {
    const csv = leadsToCsv([LEAD]);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe(
      "id,name,phone,email,source,status,createdAt,firstOutreachSentAt,lastContactedAt,followUpCount," +
        "nextFollowUpAt,requestedService,previousQuote,previousConversationSummary,appointmentStatus," +
        "preferredChannel,hadMissedCall,respondedAfterContact,notes"
    );
    expect(row).toBe(
      "lead-1,Jordan Smith,+27821234567,jordan@example.com,crm,contacted_no_response,2026-08-01T00:00:00.000Z" +
        ",,,1,,fencing,,,,,true,,"
    );
  });

  it("leaves undefined fields blank rather than printing 'undefined'", () => {
    const csv = leadsToCsv([{ ...LEAD, name: undefined, notes: undefined }]);
    const [, row] = csv.split("\r\n");
    expect(row).not.toContain("undefined");
  });

  it("quotes a field containing a comma, and doubles any internal quotes", () => {
    const csv = leadsToCsv([{ ...LEAD, notes: 'Called, left a "quick" voicemail' }]);
    const [, row] = csv.split("\r\n");
    expect(row).toContain('"Called, left a ""quick"" voicemail"');
  });

  it("quotes a field containing a newline", () => {
    const csv = leadsToCsv([{ ...LEAD, notes: "line one\nline two" }]);
    const [, row] = csv.split("\r\n");
    expect(row).toContain('"line one\nline two"');
  });

  it("produces just the header for an empty lead list", () => {
    const csv = leadsToCsv([]);
    expect(csv.split("\r\n")).toHaveLength(1);
  });

  it("neutralizes a leading =, +, -, or @ so a spreadsheet app opens it as text, not a formula", () => {
    // Regression test / CSV-formula-injection hardening: this export is
    // meant to be opened directly in Excel/Google Sheets, and `notes` (and
    // several other fields) can originate from a lead's own inbound
    // message, not just this business's own input.
    for (const formula of ["=cmd|'/c calc'!A1", "+1+1", "-1+1", "@SUM(1+1)"]) {
      const csv = leadsToCsv([{ ...LEAD, notes: formula }]);
      const [, row] = csv.split("\r\n");
      expect(row.endsWith(`'${formula}`)).toBe(true);
    }
  });

  it("still quotes a neutralized formula field if it also contains a comma", () => {
    const csv = leadsToCsv([{ ...LEAD, notes: '=HYPERLINK("http://evil.example","click")' }]);
    const [, row] = csv.split("\r\n");
    expect(row.endsWith(`"'=HYPERLINK(""http://evil.example"",""click"")"`)).toBe(true);
  });

  it("does not neutralize a leading + on the phone column — that's normal E.164 formatting", () => {
    const csv = leadsToCsv([{ ...LEAD, phone: "+27821234567" }]);
    const [, row] = csv.split("\r\n");
    expect(row).toContain(",+27821234567,");
  });

  it("still neutralizes = / - / @ on the phone column even though + is allowed there", () => {
    const csv = leadsToCsv([{ ...LEAD, phone: "=2+2" }]);
    const [, row] = csv.split("\r\n");
    expect(row).toContain(",'=2+2,");
  });
});
