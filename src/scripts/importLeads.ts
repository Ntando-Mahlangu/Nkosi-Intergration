import { readFile } from "node:fs/promises";
import { createStores } from "../store/index.js";
import { generateId } from "../idgen.js";
import type { Lead } from "../types.js";
import { isLeadSource } from "../types.js";

/** Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes, and CRLF/LF line endings. */
function parseCsv(text: string): string[][] {
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

function parseArgs(argv: string[]): { tenantId?: string; file?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return { tenantId: out.tenant, file: out.file };
}

/**
 * Bulk-imports leads from a CSV export (the common handoff format when a
 * business gives you their old CRM/spreadsheet data rather than a live API
 * connection). Expected headers (case-insensitive, all but phone/email
 * optional): name, phone, email, source, createdAt, requestedService,
 * previousQuote, notes. At least one of phone/email is required per row.
 */
async function main() {
  const { tenantId, file } = parseArgs(process.argv.slice(2));
  if (!tenantId || !file) {
    console.error("Usage: npm run import-leads -- --tenant <tenantId> --file <path-to-csv>");
    process.exitCode = 1;
    return;
  }

  const stores = createStores();
  const tenant = await stores.tenantStore.getTenant(tenantId);
  if (!tenant) {
    console.error(`No such tenant: ${tenantId}`);
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(file, "utf-8");
  const rows = parseCsv(raw);
  const [header, ...dataRows] = rows;
  if (!header) {
    console.error("CSV file is empty.");
    process.exitCode = 1;
    return;
  }
  const columns = header.map((h) => h.trim().toLowerCase());
  const col = (row: string[], name: string) => {
    const idx = columns.indexOf(name);
    return idx >= 0 ? row[idx]?.trim() : undefined;
  };

  let imported = 0;
  let skipped = 0;
  for (const row of dataRows) {
    const phone = col(row, "phone");
    const email = col(row, "email");
    if (!phone && !email) {
      skipped++;
      continue;
    }

    const lead: Lead = {
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
      notes: col(row, "notes") || undefined,
    };

    await stores.leadStore.createLead(lead);
    imported++;
  }

  console.log(
    `Imported ${imported} lead(s) for tenant ${tenantId}${skipped ? `, skipped ${skipped} row(s) with no phone/email` : ""}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
