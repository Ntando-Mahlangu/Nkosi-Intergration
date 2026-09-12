import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response } from "express";
import type { Lead } from "./types.js";
import { InMemoryLeadStore } from "./store/leadStore.js";
import { buildRecoveryPlans, runRecoveryWorkflow } from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadSampleLeads(): Lead[] {
  const dataPath = path.join(__dirname, "..", "data", "sample-leads.json");
  return JSON.parse(readFileSync(dataPath, "utf-8"));
}

export function createApp(initialLeads: Lead[] = loadSampleLeads()) {
  const store = new InMemoryLeadStore(initialLeads);
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/leads", async (_req: Request, res: Response) => {
    res.json(await store.getAllLeads());
  });

  // Dry run: score + compose messages without sending or mutating lead status.
  app.get("/leads/plan", async (_req: Request, res: Response) => {
    const leads = await store.getAllLeads();
    res.json(buildRecoveryPlans(leads, { businessName: "Nkosi Integrations" }));
  });

  // Executes the full workflow: sends messages via channel adapters and
  // updates lead status/lastContactedAt in the store.
  app.post("/workflow/run", async (_req: Request, res: Response) => {
    const result = await runRecoveryWorkflow(store, { businessName: "Nkosi Integrations" });
    res.json(result);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`LeadRecovery API listening on http://localhost:${port}`);
  });
}
