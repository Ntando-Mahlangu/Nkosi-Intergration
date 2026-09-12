import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Lead } from "./types.js";
import { InMemoryLeadStore } from "./store/leadStore.js";
import { runRecoveryWorkflow } from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dataPath = process.argv[2] ?? path.join(__dirname, "..", "data", "sample-leads.json");
  const raw = await readFile(dataPath, "utf-8");
  const leads: Lead[] = JSON.parse(raw);

  const store = new InMemoryLeadStore(leads);
  const result = await runRecoveryWorkflow(store, { businessName: "Nkosi Integrations" });

  console.log(`\n=== LeadRecovery run: ${result.sent.length} contacted, ${result.skipped.length} skipped ===\n`);

  for (const { plan, result: sendResult } of result.sent) {
    console.log(
      `[${plan.priority}] ${plan.lead.name ?? plan.lead.id} via ${plan.message.channel} ` +
        `(${sendResult.ok ? "sent" : `failed: ${sendResult.detail}`})`
    );
    console.log(`  reasons: ${plan.priorityReasons.join("; ")}`);
    console.log(`  message: ${plan.message.body}\n`);
  }

  if (result.skipped.length > 0) {
    console.log("--- Skipped ---");
    for (const { lead, reason } of result.skipped) {
      console.log(`  ${lead.name ?? lead.id}: ${reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
