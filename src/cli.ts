import { DEMO_TENANT } from "./demoTenant.js";
import { createStores } from "./store/index.js";
import { runRecoveryWorkflow } from "./workflow.js";
import { withTenantWorkflowLock } from "./workflowLock.js";

async function main() {
  const stores = createStores();
  const tenant = (await stores.tenantStore.getTenant(DEMO_TENANT.id)) ?? DEMO_TENANT;
  // Locked the same way server.ts/worker.ts are: if DATABASE_URL points at
  // a real tenant this CLI shares with a running worker/server, this run
  // can't overlap theirs and double-send.
  const result = await withTenantWorkflowLock(tenant.id, () =>
    runRecoveryWorkflow(tenant, stores.leadStore, stores.messageStore)
  );

  console.log(
    `\n=== LeadRecovery run: ${result.sent.length} contacted, ${result.skipped.length} skipped, ${result.deferred.length} deferred ===\n`
  );

  for (const { plan, result: sendResult, isFollowUp } of result.sent) {
    console.log(
      `[${plan.priority}${isFollowUp ? " FOLLOW-UP" : ""}] ${plan.lead.name ?? plan.lead.id} via ${plan.message.channel} ` +
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

  if (result.deferred.length > 0) {
    console.log("--- Deferred (quiet hours) ---");
    for (const { lead, reason } of result.deferred) {
      console.log(`  ${lead.name ?? lead.id}: ${reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
