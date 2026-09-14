import pg from "pg";

let pool: pg.Pool | undefined;

/** Lazily creates a singleton connection pool from DATABASE_URL. */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set — cannot create a Postgres connection pool.");
    }
    const max = Number(process.env.LEADRECOVERY_DB_POOL_MAX ?? 10);
    pool = new pg.Pool({ connectionString, max });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
