import cron from "node-cron";
import { createStores } from "./store/index.js";
import { runRecoveryWorkflow } from "./workflow.js";
import { mapWithConcurrency } from "./concurrency.js";

// Bounds how many tenants this worker processes in parallel per tick. Only
// meaningful within a single worker process/replica — run exactly one
// worker replica (see DEPLOYMENT.md); running more than one would send
// every due message multiple times, since nothing here coordinates across
// separate processes.
const CONCURRENCY = Number(process.env.LEADRECOVERY_WORKER_CONCURRENCY ?? 4);

async function runOnce(): Promise<void> {
  const stores = createStores();
  const tenants = (await stores.tenantStore.listTenants()).filter((t) => t.status !== "suspended");
  const now = new Date();

  await mapWithConcurrency(tenants, CONCURRENCY, async (tenant) => {
    try {
      const result = await runRecoveryWorkflow(tenant, stores.leadStore, stores.messageStore, now);
      const sentCount = result.sent.filter((s) => s.result.ok).length;
      console.log(
        `[worker] tenant=${tenant.id} sent=${sentCount} skipped=${result.skipped.length} deferred=${result.deferred.length}`
      );
    } catch (err) {
      // One tenant's failure must never take down the run for every other tenant.
      console.error(`[worker] tenant=${tenant.id} failed:`, err);
    }
  });
}

const schedule = process.env.LEADRECOVERY_CRON_SCHEDULE ?? "0 * * * *"; // default: hourly

if (process.env.LEADRECOVERY_RUN_ONCE === "true") {
  runOnce()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  console.log(`[worker] scheduling recovery workflow on cron "${schedule}" (concurrency=${CONCURRENCY})`);
  cron.schedule(schedule, () => {
    runOnce().catch((err) => console.error("[worker] run failed:", err));
  });
  // Also run once immediately on startup so a freshly deployed worker doesn't wait for the first tick.
  runOnce().catch((err) => console.error("[worker] initial run failed:", err));
}
