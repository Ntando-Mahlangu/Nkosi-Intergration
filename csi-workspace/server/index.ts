import { openDb } from "./db/index.js";
import { bootstrap } from "./db/bootstrap.js";
import { seedDemo, ensureBootstrapAdmin } from "./db/seed.js";
import { createApp, loadConfig } from "./app.js";
import { startAutomation } from "./automation.js";

const config = loadConfig();
const db = openDb(process.env.DATABASE_PATH || "./data/csi-workspace.db");
bootstrap(db);

if (process.env.SEED_DEMO_DATA === "true" && !db.get("SELECT 1 FROM users LIMIT 1")) {
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
app.listen(port, () => console.log(`CSI Workspace listening on http://localhost:${port} (${config.env})`));
startAutomation({ db, config });
