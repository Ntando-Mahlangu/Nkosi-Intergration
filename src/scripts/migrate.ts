import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const migrationsDir = path.join(__dirname, "..", "db", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const pool = getPool();

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf-8");
    console.log(`Applying migration ${file}...`);
    await pool.query(sql);
  }

  console.log(`Applied ${files.length} migration(s).`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
