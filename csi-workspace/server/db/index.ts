import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from "node:sqlite";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Loaded via require so bundlers/test runners that do not know the newer node:sqlite builtin leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(here, "migrations");

export type Row = Record<string, unknown>;
export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

/**
 * Thin, synchronous wrapper over node:sqlite. All SQL in the app goes through
 * these helpers with bound parameters — never string-concatenated user input.
 * The data layer is deliberately small so it can be swapped for PostgreSQL
 * (see docs/ARCHITECTURE.md) without touching route logic.
 */
export class Db {
  readonly raw: DatabaseSyncT;
  private txDepth = 0;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA foreign_keys = ON;");
    if (file !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }
  /** Insert a row from an object; undefined values are skipped. */
  insert(table: string, row: Record<string, unknown>) {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
    return this.run(sql, ...keys.map((k) => toSql(row[k])));
  }
  /** Update columns of a row by id; undefined values are skipped. */
  update(table: string, id: string, patch: Record<string, unknown>, idCol = "id") {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${idCol} = ?`;
    return this.run(sql, ...keys.map((k) => toSql(patch[k])), id);
  }
  /** Run fn in a transaction (nested calls join the outer transaction). */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.raw.exec("BEGIN");
    this.txDepth++;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth--;
    }
  }
  close() {
    this.raw.close();
  }
}

export function toSql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  return v as SQLInputValue;
}

/** Apply every *.sql file in migrations/ (sorted) that has not been applied yet. */
export function migrate(db: Db): string[] {
  db.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    db.tx(() => {
      db.raw.exec(sql);
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", f, new Date().toISOString());
    });
    ran.push(f);
  }
  return ran;
}

export function openDb(file: string): Db {
  const db = new Db(file);
  migrate(db);
  return db;
}
