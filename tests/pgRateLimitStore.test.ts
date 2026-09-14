import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredRateLimitCounters, PgRateLimitStore } from "../src/middleware/pgRateLimitStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");
const MIGRATION_SQLS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"));

function createTestPool(): Pool {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: "now", implementation: () => new Date() });
  const { Pool: MemPool } = db.adapters.createPg();
  return new MemPool() as unknown as Pool;
}

describe("PgRateLimitStore (against an in-memory pg-mem instance)", () => {
  let pool: Pool;
  let store: PgRateLimitStore;

  beforeEach(async () => {
    pool = createTestPool();
    for (const sql of MIGRATION_SQLS) await pool.query(sql);
    store = new PgRateLimitStore(pool, "test");
    store.init({ windowMs: 60_000 } as never);
  });

  it("starts a key's count at 1 on the first increment", async () => {
    const result = await store.increment("ip:1.2.3.4");
    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBeInstanceOf(Date);
  });

  it("increments the same key's count within the same window", async () => {
    await store.increment("ip:1.2.3.4");
    await store.increment("ip:1.2.3.4");
    const third = await store.increment("ip:1.2.3.4");
    expect(third.totalHits).toBe(3);
  });

  it("tracks different keys independently", async () => {
    await store.increment("ip:1.2.3.4");
    await store.increment("ip:1.2.3.4");
    const other = await store.increment("ip:5.6.7.8");
    expect(other.totalHits).toBe(1);
  });

  it("decrement reduces the current window's count, floored at zero", async () => {
    await store.increment("ip:1.2.3.4");
    await store.increment("ip:1.2.3.4");
    await store.decrement("ip:1.2.3.4");
    const result = await store.increment("ip:1.2.3.4");
    expect(result.totalHits).toBe(2);

    await store.decrement("ip:1.2.3.4");
    await store.decrement("ip:1.2.3.4");
    await store.decrement("ip:1.2.3.4");
    const result2 = await store.increment("ip:1.2.3.4");
    expect(result2.totalHits).toBe(1); // never goes negative
  });

  it("resetKey clears all windows for a key", async () => {
    await store.increment("ip:1.2.3.4");
    await store.increment("ip:1.2.3.4");
    await store.resetKey("ip:1.2.3.4");
    const result = await store.increment("ip:1.2.3.4");
    expect(result.totalHits).toBe(1);
  });

  it("isolates counts between two limiters that share a key and windowMs but have different prefixes", async () => {
    // Regression test: express-rate-limit's default keyGenerator is just the
    // client IP, so two limiters with the same windowMs (e.g. the webhook
    // and tenant limiters, both 60s) would otherwise increment the exact
    // same Postgres row for the same IP without a distinct prefix per
    // limiter — one limiter's traffic would inflate the other's count.
    const webhookLimiter = new PgRateLimitStore(pool, "webhook");
    webhookLimiter.init({ windowMs: 60_000 } as never);
    const tenantLimiter = new PgRateLimitStore(pool, "tenant");
    tenantLimiter.init({ windowMs: 60_000 } as never);

    await webhookLimiter.increment("1.2.3.4");
    await webhookLimiter.increment("1.2.3.4");
    await webhookLimiter.increment("1.2.3.4");

    const tenantResult = await tenantLimiter.increment("1.2.3.4");
    expect(tenantResult.totalHits).toBe(1); // unaffected by the webhook limiter's 3 hits for the same IP
  });

  it("starts a new window's count fresh once windowMs has elapsed", async () => {
    // Mocks Date.now() directly rather than vi.useFakeTimers() — full fake
    // timers freeze the setTimeout-based scheduling pg-mem's query emulation
    // relies on internally, hanging the `await` on the mocked pool forever.
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    await store.increment("ip:1.2.3.4");
    dateSpy.mockReturnValue(70_000); // past the 60s window
    const result = await store.increment("ip:1.2.3.4");
    expect(result.totalHits).toBe(1);
    dateSpy.mockRestore();
  });
});

describe("cleanupExpiredRateLimitCounters", () => {
  it("deletes only windows older than the 1-hour cutoff", async () => {
    const pool = createTestPool();
    for (const sql of MIGRATION_SQLS) await pool.query(sql);

    const now = Date.now();
    await pool.query(`INSERT INTO rate_limit_counters (key, window_start, count) VALUES ($1, $2, 1)`, [
      "old",
      now - 2 * 60 * 60 * 1000,
    ]);
    await pool.query(`INSERT INTO rate_limit_counters (key, window_start, count) VALUES ($1, $2, 1)`, ["recent", now]);

    await cleanupExpiredRateLimitCounters(pool);

    const { rows } = await pool.query(`SELECT key FROM rate_limit_counters`);
    expect(rows.map((r) => r.key)).toEqual(["recent"]);
  });
});
