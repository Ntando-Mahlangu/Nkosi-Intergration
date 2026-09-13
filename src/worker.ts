import cron from "node-cron";
import { createStores } from "./store/index.js";
import { runRecoveryWorkflow } from "./workflow.js";

async function runOnce(): Promise<void> {
  const stores = createStores();
  const tenants = await stores.tenantStore.listTenants();
  const now = new Date();

  for (const tenant of tenants) {
    const result = await runRecoveryWorkflow(tenant, stores.leadStore, stores.messageStore, now);
    const sentCount = result.sent.filter((s) => s.result.ok).length;
    console.log(
      `[worker] tenant=${tenant.id} sent=${sentCount} skipped=${result.skipped.length} deferred=${result.deferred.length}`
    );
  }
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
  console.log(`[worker] scheduling recovery workflow on cron "${schedule}"`);
  cron.schedule(schedule, () => {
    runOnce().catch((err) => console.error("[worker] run failed:", err));
  });
  // Also run once immediately on startup so a freshly deployed worker doesn't wait for the first tick.
  runOnce().catch((err) => console.error("[worker] initial run failed:", err));
}
