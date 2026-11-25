/** `npm run seed` — create a fresh database with demonstration data. Refuses to touch a non-empty database. */
import { openDb } from "./index.js";
import { bootstrap } from "./bootstrap.js";
import { seedDemo } from "./seed.js";
import { loadConfig } from "../app.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const file = process.env.DATABASE_PATH || "./data/csi-workspace.db";
const db = openDb(file);
bootstrap(db);
if (db.get("SELECT 1 FROM users LIMIT 1")) {
  console.error(`[seed] ${file} already has users — refusing to add demo data. Delete the data/ folder to start fresh.`);
  process.exit(1);
}
const pw = seedDemo(db, loadConfig().demoPassword);
console.log(`[seed] Demo data written to ${file}. Demo password: ${pw}`);
