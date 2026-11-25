// Load .env if present (Node >= 22 built-in; no dependency).
try {
  process.loadEnvFile();
} catch {
  /* no .env file — use the environment as-is */
}

import fs from "node:fs";
import { openDb } from "./db/index.js";
import { bootstrap } from "./db/bootstrap.js";
import { seedDemo, ensureBootstrapAdmin } from "./db/seed.js";
import { createApp, loadConfig } from "./app.js";
import { startAutomation } from "./automation.js";

const config = loadConfig();
const db = openDb(process.env.DATABASE_PATH || "./data/csi-workspace.db");
bootstrap(db);

// Demo data: on by default in development (empty database only), opt-in elsewhere.
const wantDemo = process.env.SEED_DEMO_DATA ? process.env.SEED_DEMO_DATA === "true" : config.env === "development";
if (wantDemo && !db.get("SELECT 1 FROM users LIMIT 1")) {
  if (config.env === "production" && process.env.ALLOW_DEMO_IN_PRODUCTION !== "true") {
    console.warn("[seed] SEED_DEMO_DATA ignored in production (set ALLOW_DEMO_IN_PRODUCTION=true for a demo deployment).");
  } else {
    const pw = seedDemo(db, config.demoPassword);
    console.log(`[seed] Demonstration data loaded. Demo accounts use password: ${pw}`);
  }
}
ensureBootstrapAdmin(db, process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD);

const app = createApp(db, config);
const port = Number(process.env.PORT || 4000);
const hasClientBuild = [new URL("../dist-client/index.html", import.meta.url), new URL("../../dist-client/index.html", import.meta.url)].some((u) => {
  try {
    return fs.existsSync(u);
  } catch {
    return false;
  }
});
const server = app.listen(port, () => {
  console.log(`CSI Workspace API listening on port ${port} (${config.env})`);
  if (hasClientBuild) console.log(`\n  ➜  Open http://localhost:${port}\n`);
  else console.log(`\n  ➜  Open http://localhost:5173  (the web app, served by Vite in development)\n`);
  if (db.get("SELECT 1 FROM users WHERE is_demo = 1 LIMIT 1") && config.env !== "production" && config.demoPassword)
    console.log(`  Demo sign-in: e.g. lerato@demo.csi.example / ${config.demoPassword}\n`);
});
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") console.error(`\nPort ${port} is already in use. Stop the other process or set PORT=<another port> in .env.\n`);
  else console.error(e);
  process.exit(1);
});
startAutomation({ db, config });
