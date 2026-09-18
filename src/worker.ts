import cron from "node-cron";
import { createStores, type Stores } from "./store/index.js";
import { runRecoveryWorkflow } from "./workflow.js";
import { mapWithConcurrency } from "./concurrency.js";
import { logger } from "./logger.js";
import { deliverNotification, NOTIFICATION_MAX_ATTEMPTS } from "./notify.js";
import { cleanupExpiredRateLimitCounters } from "./middleware/pgRateLimitStore.js";
import { getPool } from "./db/pool.js";
import { installFatalErrorHandlers } from "./fatalErrorHandlers.js";
import { acquireWorkerLockOrExit } from "./workerLock.js";
import { withTenantWorkflowLock } from "./workflowLock.js";
import { sendOperatorAlert } from "./operatorAlert.js";

// This file is always run directly (nothing else imports it), so this is
// always the actual process entrypoint — safe to install unconditionally,
// unlike server.ts which also gets imported by tests.
installFatalErrorHandlers("worker");

// Bounds how many tenants this worker processes in parallel per tick. Only
// meaningful within a single worker process/replica — run exactly one
// worker replica (see DEPLOYMENT.md); running more than one would send
// every due message multiple times. When DATABASE_URL is set this is
// actually enforced below via acquireWorkerLockOrExit(), not just
// documented — a second replica exits immediately instead of running.
const CONCURRENCY = Number(process.env.LEADRECOVERY_WORKER_CONCURRENCY ?? 4);

// Created once for the lifetime of this process, not per tick. With
// DATABASE_URL set this doesn't matter much (every call just wraps the same
// underlying pool) — but without it, createStores() builds fresh in-memory
// stores reloaded from data/sample-leads.json, discarding every lead's sent/
// opted-out/follow-up state from the previous tick. Calling it once here
// (not inside runOnce()) means a worker left running in local/demo mode
// (LEADRECOVERY_RUN_ONCE unset, no Postgres) doesn't re-send the initial
// outreach to the same leads on every single scheduled tick forever.
const stores = createStores();

/**
 * Retries every not-yet-dead failed notification (see notify.ts) once per
 * tick, with the same bounded concurrency as the tenant loop below (a long
 * backlog — e.g. after an extended notifyWebhookUrl outage — would
 * otherwise serialize one HTTP round-trip at a time and stretch a single
 * tick well past its cron interval). A worker tick is naturally spaced out
 * (hourly by default), which is a reasonable backoff for a webhook target
 * that's down — no need for the inline exponential backoff notify.ts
 * itself avoids for latency reasons.
 */
async function redeliverFailedNotifications(stores: Stores): Promise<void> {
  const pending = await stores.notificationStore.listPending();
  await mapWithConcurrency(pending, CONCURRENCY, async (n) => {
    try {
      const result = await deliverNotification(n.webhookUrl, n.payload);
      if (result.ok) {
        await stores.notificationStore.markDelivered(n.id);
        logger.info("notification_redelivered", { tenantId: n.tenantId, leadId: n.leadId, reason: n.reason });
      } else {
        await stores.notificationStore.markAttemptFailed(n.id, result.error, NOTIFICATION_MAX_ATTEMPTS);
        logger.warn("notification_redelivery_failed", {
          tenantId: n.tenantId,
          leadId: n.leadId,
          attempts: n.attempts + 1,
          error: result.error,
        });
        // Mirrors the store's own pending->dead condition (see
        // markAttemptFailed in store/memory.ts and store/postgres.ts) —
        // this is the one tick where a human needs to notice: nothing will
        // retry this notification again, and its target (usually a broken
        // notifyWebhookUrl) needs fixing.
        if (n.attempts + 1 >= NOTIFICATION_MAX_ATTEMPTS) {
          void sendOperatorAlert(`Notification permanently failed for tenant ${n.tenantId}`, {
            tenantId: n.tenantId,
            leadId: n.leadId,
            reason: n.reason,
            error: result.error,
          });
        }
      }
    } catch (err) {
      // One notification's bookkeeping failure (e.g. a transient DB error
      // in markDelivered/markAttemptFailed) must never stop the rest of
      // the backlog from being retried this tick.
      logger.error("notification_redelivery_error", {
        tenantId: n.tenantId,
        leadId: n.leadId,
        error: (err as Error).message,
      });
    }
  });
}

async function runOnce(): Promise<void> {
  const tenants = (await stores.tenantStore.listTenants()).filter((t) => t.status !== "suspended");
  const now = new Date();

  await mapWithConcurrency(tenants, CONCURRENCY, async (tenant) => {
    try {
      const result = await withTenantWorkflowLock(tenant.id, () =>
        runRecoveryWorkflow(tenant, stores.leadStore, stores.messageStore, now)
      );
      const sentCount = result.sent.filter((s) => s.result.ok).length;
      logger.info("worker_tick", {
        tenantId: tenant.id,
        sent: sentCount,
        skipped: result.skipped.length,
        deferred: result.deferred.length,
      });
    } catch (err) {
      // One tenant's failure must never take down the run for every other tenant.
      logger.error("worker_tick_failed", { tenantId: tenant.id, error: (err as Error).message });
    }
  });

  await redeliverFailedNotifications(stores);

  if (process.env.DATABASE_URL) {
    await cleanupExpiredRateLimitCounters(getPool());
  }
}

const schedule = process.env.LEADRECOVERY_CRON_SCHEDULE ?? "0 * * * *"; // default: hourly

await acquireWorkerLockOrExit(); // never returns if another worker already holds the lock

if (process.env.LEADRECOVERY_RUN_ONCE === "true") {
  runOnce()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("worker_run_once_failed", { error: (err as Error).message });
      void sendOperatorAlert(`Worker run failed: ${(err as Error).message}`).finally(() => process.exit(1));
    });
} else {
  logger.info("worker_scheduled", { schedule, concurrency: CONCURRENCY });
  cron.schedule(schedule, () => {
    runOnce().catch((err) => {
      logger.error("worker_run_failed", { error: (err as Error).message });
      void sendOperatorAlert(`Worker tick failed: ${(err as Error).message}`);
    });
  });
  // Also run once immediately on startup so a freshly deployed worker doesn't wait for the first tick.
  runOnce().catch((err) => {
    logger.error("worker_initial_run_failed", { error: (err as Error).message });
    void sendOperatorAlert(`Worker's initial run failed: ${(err as Error).message}`);
  });
}
