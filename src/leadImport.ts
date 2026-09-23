import { generateId } from "./idgen.js";
import type { Lead } from "./types.js";
import { isLeadSource } from "./types.js";

/** Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes, and CRLF/LF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

export interface ParsedLeadsCsv {
  /** Leads ready to hand to leadStore.createLead — id/tenantId already filled in. */
  leads: Lead[];
  /** Rows with neither a phone nor an email — every other column is optional. */
  skippedCount: number;
}

/**
 * Shared by `npm run import-leads` (CLI, reads a local file) and
 * `POST /leads/import` (web UI, reads an uploaded file's contents) so the
 * column mapping/validation can't drift between the two entry points.
 * Expected headers (case-insensitive, all but phone/email optional): name,
 * phone, email, source, createdAt, requestedService, previousQuote,
 * appointmentAt, notes.
 */
export function parseLeadsCsv(text: string, tenantId: string): ParsedLeadsCsv {
  const rows = parseCsv(text);
  const [header, ...dataRows] = rows;
  if (!header) return { leads: [], skippedCount: 0 };

  const columns = header.map((h) => h.trim().toLowerCase());
  const col = (row: string[], name: string) => {
    const idx = columns.indexOf(name);
    return idx >= 0 ? row[idx]?.trim() : undefined;
  };

  const leads: Lead[] = [];
  let skippedCount = 0;

  for (const row of dataRows) {
    const phone = col(row, "phone");
    const email = col(row, "email");
    if (!phone && !email) {
      skippedCount++;
      continue;
    }

    const appointmentAtRaw = col(row, "appointmentat");
    const appointmentAt =
      appointmentAtRaw && !Number.isNaN(Date.parse(appointmentAtRaw))
        ? new Date(appointmentAtRaw).toISOString()
        : undefined;

    leads.push({
      id: generateId("lead"),
      tenantId,
      name: col(row, "name") || undefined,
      phone: phone || undefined,
      email: email || undefined,
      // Falls back to "spreadsheet" both when the column is absent/blank and
      // when it's present but not one of the known LeadSource values — an
      // unvalidated cast here would silently store arbitrary CSV text in a
      // field every other part of the codebase (scoring.ts, this file's own
      // callers) assumes is one of the closed LeadSource union's values.
      source: (() => {
        const raw = col(row, "source");
        return isLeadSource(raw) ? raw : "spreadsheet";
      })(),
      createdAt: col(row, "createdat") || new Date().toISOString(),
      status: "new",
      requestedService: col(row, "requestedservice") || undefined,
      previousQuote: col(row, "previousquote") || undefined,
      appointmentAt,
      appointmentStatus: appointmentAt ? "booked" : undefined,
      notes: col(row, "notes") || undefined,
    });
  }

  return { leads, skippedCount };
}
