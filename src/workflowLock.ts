import pg from "pg";
import { logger } from "./logger.js";

// Namespaces this lock's keyspace away from workerLock.ts's own fixed
// advisory-lock key (894_613_571) — Postgres advisory locks taken via the
// single-bigint form and the two-int form share one keyspace, so two
// unrelated locks using the same underlying key would block each other.
// hashtextextended's own hash output already makes a collision between two
// *different* tenant ids astronomically unlikely; this constant only
// guards against colliding with workerLock's single fixed key.
const LOCK_NAMESPACE = "leadrecovery-workflow";

const inProcessQueues = new Map<string, Promise<unknown>>();

let lockPool: pg.Pool | undefined;

/**
 * A small pool dedicated to holding per-tenant advisory locks, separate
 * from the shared pg.Pool (src/db/pool.ts) that runRecoveryWorkflow's own
 * store queries draw from — a lock connection held for the whole call would
 * otherwise compete with, and can deadlock against, those same queries for
 * the shared pool's limited connections (workerLock.ts avoids the same
 * problem by using its own dedicated connection too). Bounded, rather than
 * one brand-new `pg.Client` per call: without a cap, enough tenants
 * triggering POST /workflow/run at once (nothing else bounds cross-tenant
 * concurrency there) could open unlimited connections to Postgres. A caller
 * beyond this pool's max just queues for a lock connection to free up —
 * the same backpressure the shared pool already provides for queries.
 */
function getLockPool(): pg.Pool {
  if (!lockPool) {
    lockPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return lockPool;
}

interface LockConnection {
  query(sql: string, params: unknown[]): Promise<unknown>;
  release(): void;
}

/**
 * Exported (rather than kept private) so tests can exercise the actual
 * lock/unlock/error-handling logic against a fake connection, without
 * needing to mock the "pg" module's Pool constructor.
 */
export async function withDbLock<T>(
  tenantId: string,
  fn: () => Promise<T>,
  acquire: () => Promise<LockConnection> = () => getLockPool().connect()
): Promise<T> {
  const key = `${LOCK_NAMESPACE}:${tenantId}`;
  const client = await acquire();
  try {
    // Session-level pg_advisory_lock (not the transaction-scoped
    // _xact_ variant): this needs to stay held across every query
    // runRecoveryWorkflow makes on the shared pool, not just one
    // transaction, and blocking (not pg_try_advisory_lock) is correct here —
    // a manual "run workflow now" trigger that lands mid-tick should wait
    // for the tick to finish and then run, not silently no-op.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await fn();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch (err) {
        // Logged rather than thrown: a throw here would replace fn()'s own
        // pending error (if it failed) instead of adding to it, hiding the
        // real cause from the caller during exactly the kind of DB trouble
        // that would make this query fail too. The lock still releases on
        // its own once `client.release()` below returns this connection.
        logger.warn("workflow_lock_unlock_failed", { tenantId, error: (err as Error).message });
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Serializes runRecoveryWorkflow calls for one tenant so two overlapping
 * runs — the worker's own cron tick racing a manually-triggered
 * POST /workflow/run, or two manual triggers in quick succession — can
 * never both read the same lead as "not yet contacted" and send it the
 * same initial-outreach or follow-up message twice. Without this,
 * sendPlans's own onlyIfStatusIn guard (workflow.ts) only prevents one of
 * the two concurrent writes from corrupting the lead's stored status; by
 * the time either write happens, both sends have already gone out to the
 * customer.
 *
 * Two layers, since the API server and worker run as separate OS processes
 * in a real deployment (DEPLOYMENT.md) and don't share a JS event loop:
 *  - Always: an in-process queue. This is the only layer that matters
 *    against the in-memory demo store (DATABASE_URL unset) — that store
 *    isn't shared across processes, so two demo-mode processes can't race
 *    on the same lead anyway, but two overlapping calls to *this* process
 *    (e.g. a doubled click on "run workflow now") still can.
 *  - When DATABASE_URL is set: a Postgres advisory lock, keyed per tenant,
 *    held for the duration of the call — so the API server process and the
 *    worker process, which share the database but not the event loop, are
 *    serialized too.
 */
export function withTenantWorkflowLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const previous = inProcessQueues.get(tenantId) ?? Promise.resolve();
  const runLocked = () => (process.env.DATABASE_URL ? withDbLock(tenantId, fn) : fn());
  const next = previous.then(runLocked, runLocked); // run fn() next regardless of how the previous call in this tenant's queue settled
  // Chain future calls off a version of `next` that never rejects, so one
  // tenant's failed run doesn't poison every later run for that same tenant.
  const settled = next.catch(() => undefined);
  inProcessQueues.set(tenantId, settled);
  // Best-effort cleanup: once settled, drop this tenant's entry — but only
  // if no newer call has queued behind it in the meantime (that check is
  // why this isn't just `inProcessQueues.delete(tenantId)` unconditionally,
  // which could evict a different, still-pending call's entry instead).
  void settled.then(() => {
    if (inProcessQueues.get(tenantId) === settled) inProcessQueues.delete(tenantId);
  });
  return next;
}
