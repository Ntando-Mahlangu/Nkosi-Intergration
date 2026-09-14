import type { Pool } from "pg";
import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";

/**
 * A Postgres-backed express-rate-limit Store, so limits are enforced across
 * every app replica sharing this database instead of only within one
 * process's memory (the library's default in-memory Store would let a
 * limit of N/window become effectively N*replicas/window once you scale
 * the app service — see DEPLOYMENT.md). Used automatically when
 * DATABASE_URL is set; the in-memory default is fine for the single-process
 * demo/test setup.
 *
 * Fixed-window counter backed by the rate_limit_counters table: window_start
 * is the window's start time in epoch milliseconds, so all requests in the
 * same windowMs-sized bucket share one row.
 */
export class PgRateLimitStore implements Store {
  private windowMs = 60_000;

  constructor(private pool: Pool) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private currentWindowStart(): number {
    return Math.floor(Date.now() / this.windowMs) * this.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const windowStart = this.currentWindowStart();
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limit_counters (key, window_start, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_counters.count + 1
       RETURNING count`,
      [key, windowStart]
    );
    return { totalHits: Number(rows[0].count), resetTime: new Date(windowStart + this.windowMs) };
  }

  async decrement(key: string): Promise<void> {
    const windowStart = this.currentWindowStart();
    await this.pool.query(
      `UPDATE rate_limit_counters SET count = GREATEST(count - 1, 0) WHERE key = $1 AND window_start = $2`,
      [key, windowStart]
    );
  }

  async resetKey(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM rate_limit_counters WHERE key = $1`, [key]);
  }
}

/**
 * Deletes counter rows for windows that have already closed, so the table
 * doesn't grow forever. Called once per worker tick (see worker.ts) —
 * that's a far lower rate than per-request, and rate-limit windows here are
 * at most 15 minutes, so a 1-hour cutoff is always safely expired.
 */
export async function cleanupExpiredRateLimitCounters(pool: Pool): Promise<void> {
  const cutoff = Date.now() - 60 * 60 * 1000;
  await pool.query(`DELETE FROM rate_limit_counters WHERE window_start < $1`, [cutoff]);
}
