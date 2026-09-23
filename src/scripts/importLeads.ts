import { readFile } from "node:fs/promises";
import { createStores } from "../store/index.js";
import { parseLeadsCsv } from "../leadImport.js";

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
 * connection). See src/leadImport.ts for the expected headers — the same
 * parsing/column-mapping backs `POST /leads/import` (the web upload form in
 * public/dashboard.html) too.
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
  const { leads, skippedCount } = parseLeadsCsv(raw, tenantId);

  for (const lead of leads) {
    await stores.leadStore.createLead(lead);
  }

  console.log(
    `Imported ${leads.length} lead(s) for tenant ${tenantId}${skippedCount ? `, skipped ${skippedCount} row(s) with no phone/email` : ""}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
