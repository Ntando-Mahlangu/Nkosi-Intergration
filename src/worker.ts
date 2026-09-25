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
import { isPastRetention, retentionDaysFor } from "./dataRetention.js";
import type { Tenant } from "./types.js";

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

/**
 * Purges leads (and, in Postgres, their cascaded message history) once
 * they're both closed-out and past the tenant's data-retention window (see
 * src/dataRetention.ts / COMPLIANCE.md "Data handling"). Runs for every
 * tenant regardless of status/terms-acceptance — this is a data-hygiene
 * obligation independent of whether the agency is currently allowed to
 * contact the tenant's leads, not a "send" this app gates elsewhere.
 */
async function purgeExpiredLeads(tenants: Tenant[], now: Date): Promise<void> {
  for (const tenant of tenants) {
    const retentionDays = retentionDaysFor(tenant);
    let leads: Awaited<ReturnType<typeof stores.leadStore.getAllLeads>>;
    try {
      leads = await stores.leadStore.getAllLeads(tenant.id);
    } catch (err) {
      logger.error("retention_purge_list_failed", { tenantId: tenant.id, error: (err as Error).message });
      continue;
    }
    for (const lead of leads) {
      if (!isPastRetention(lead, retentionDays, now)) continue;
      try {
        await stores.leadStore.deleteLead(tenant.id, lead.id);
        logger.info("lead_purged_retention", { tenantId: tenant.id, leadId: lead.id, retentionDays });
      } catch (err) {
        logger.error("retention_purge_failed", { tenantId: tenant.id, leadId: lead.id, error: (err as Error).message });
      }
    }
  }
}

async function runOnce(): Promise<void> {
  const allTenants = await stores.tenantStore.listTenants();
  const now = new Date();

  // Never run the outreach workflow for a suspended tenant, nor one that
  // hasn't accepted LeadRecovery's own Terms of Service/Privacy Policy yet —
  // a brand-new tenant starts unaccepted (see migration 0013) until it
  // accepts via POST /tenants/me/accept-terms.
  const tenants = allTenants.filter((t) => t.status !== "suspended" && Boolean(t.termsAcceptedAt));

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
  await purgeExpiredLeads(allTenants, now);

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
