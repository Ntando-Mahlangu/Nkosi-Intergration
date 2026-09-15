import pg from "pg";
import { logger } from "./logger.js";

// Arbitrary fixed constant identifying this application's worker lock —
// only needs to be distinct from other advisory locks anyone might take
// against the same database; the exact value has no other meaning.
const WORKER_LOCK_KEY = 894_613_571;

/**
 * Tries to take the worker's advisory lock on an already-connected client.
 * Session-level locks (`pg_try_advisory_lock`, as opposed to the
 * transaction-scoped `pg_advisory_xact_lock`) are held by the underlying
 * connection for as long as it stays open and are released automatically
 * the instant it closes (a crash, a restart, a clean shutdown) — so
 * there's no stale-lock cleanup to worry about, and no heartbeat/expiry
 * logic needed. Closes `client` itself if the lock isn't acquired; leaves
 * it open (for the caller to hold for the process lifetime) if it is.
 *
 * Takes an already-connected client (rather than a connection string)
 * specifically so this can be exercised in tests against a pg-mem client —
 * see tests/workerLock.test.ts.
 */
export async function tryAcquireWorkerLock(client: Pick<pg.Client, "query" | "end">): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
    WORKER_LOCK_KEY,
  ]);
  if (!rows[0].locked) {
    await client.end();
    return false;
  }
  return true;
}

/**
 * Acquires the worker lock or exits the process — the standard call for
 * worker.ts's own startup, turning "run exactly one worker replica" from
 * a documented convention (see DEPLOYMENT.md) into something actually
 * enforced. A no-op (always proceeds) when DATABASE_URL isn't set: the
 * in-memory demo store has no cross-process state to corrupt, and there
 * is no shared database to coordinate through anyway.
 *
 * Deliberately opens its own dedicated `pg.Client`, not the shared
 * `pg.Pool` (src/db/pool.ts) used everywhere else: a pool can recycle/
 * close idle connections it manages, which would silently release the
 * lock without the worker knowing. This client is held open for the
 * lifetime of the process and is never returned to any pool.
 */
export async function acquireWorkerLockOrExit(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  const client = new pg.Client({ connectionString });
  await client.connect();
  const acquired = await tryAcquireWorkerLock(client);
  if (!acquired) {
    logger.error("worker_lock_not_acquired", {
      message: "another worker process already holds the lock on this database — refusing to run a second replica",
    });
    process.exit(1);
  }
}
