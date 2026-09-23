import type { Lead } from "./types.js";

/**
 * Every Lead field, in export order — a full-fidelity export for a client's
 * own records or a right-of-access request (see COMPLIANCE.md "Data
 * handling"), unlike the narrower set of columns npm run import-leads
 * accepts on the way in.
 */
const LEAD_EXPORT_COLUMNS: (keyof Lead)[] = [
  "id",
  "name",
  "phone",
  "email",
  "source",
  "status",
  "createdAt",
  "firstOutreachSentAt",
  "lastContactedAt",
  "followUpCount",
  "nextFollowUpAt",
  "requestedService",
  "previousQuote",
  "previousConversationSummary",
  "appointmentStatus",
  "appointmentAt",
  "appointmentReminderSentAt",
  "preferredChannel",
  "hadMissedCall",
  "respondedAfterContact",
  "notes",
];

// Every column but `phone` is guarded against all four OWASP-listed
// formula-trigger prefixes; `phone` skips `+` specifically since a leading
// `+` is normal, expected E.164 formatting (every phone number in this
// codebase is stored that way) — not attacker/CRM-supplied free text in
// the way notes/name/requestedService are. `=`/`-`/`@`/tab/CR still get
// neutralized even on `phone`, since a real phone number never starts with
// any of those.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const FORMULA_TRIGGER_EXCEPT_PLUS = /^[=\-@\t\r]/;

/**
 * RFC 4180 field escaping (quote, and double any internal quotes, whenever
 * a comma/quote/newline is present) plus CSV/formula-injection hardening:
 * a field a spreadsheet app would interpret as a formula gets a leading
 * `'` so it opens as inert text instead — this export is meant to be
 * opened directly in Excel/Google Sheets (see COMPLIANCE.md's
 * right-of-access use case), and several of these fields (name, notes,
 * requestedService, previousConversationSummary) can originate from a
 * lead's own inbound message or a CRM import, not just this business's
 * own input.
 */
function escapeCsvField(value: string | number | boolean | undefined, column: keyof Lead): string {
  if (value === undefined) return "";
  let str = String(value);
  const trigger = column === "phone" ? FORMULA_TRIGGER_EXCEPT_PLUS : FORMULA_TRIGGER;
  if (trigger.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function leadsToCsv(leads: Lead[]): string {
  const header = LEAD_EXPORT_COLUMNS.join(",");
  const rows = leads.map((lead) => LEAD_EXPORT_COLUMNS.map((column) => escapeCsvField(lead[column], column)).join(","));
  return [header, ...rows].join("\r\n");
}
