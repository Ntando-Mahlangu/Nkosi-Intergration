import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { createStores } from "./store/index.js";
import { requireTenantAuth } from "./middleware/auth.js";
import { createTenantRoutes } from "./routes/tenants.js";
import { createWebhookRoutes } from "./webhooks/index.js";
import { buildFollowUpPlans, buildRecoveryPlans, runRecoveryWorkflow } from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const stores = createStores();
  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Webhooks parse their own bodies (form-encoded/multipart) — mount before the global json() parser.
  app.use(createWebhookRoutes(stores));

  app.use(express.json());
  app.use(createTenantRoutes(stores.tenantStore));

  const auth = requireTenantAuth(stores.tenantStore);

  app.get("/leads", auth, async (req: Request, res: Response) => {
    res.json(await stores.leadStore.getAllLeads(req.tenant!.id));
  });

  // Dry run: initial-outreach + follow-up plans, nothing sent or mutated.
  app.get("/leads/plan", auth, async (req: Request, res: Response) => {
    const leads = await stores.leadStore.getAllLeads(req.tenant!.id);
    const initial = buildRecoveryPlans(req.tenant!, leads);
    const followUps = buildFollowUpPlans(req.tenant!, leads);
    res.json({
      plans: [...initial.plans, ...followUps.plans],
      skipped: [...initial.skipped, ...followUps.skipped],
    });
  });

  app.get("/leads/:id/messages", auth, async (req: Request, res: Response) => {
    res.json(await stores.messageStore.getMessagesForLead(req.tenant!.id, req.params.id));
  });

  // Executes the full workflow: sends via channel adapters, updates lead status, logs messages.
  app.post("/workflow/run", auth, async (req: Request, res: Response) => {
    const result = await runRecoveryWorkflow(req.tenant!, stores.leadStore, stores.messageStore);
    res.json(result);
  });

  app.use(express.static(path.join(__dirname, "..", "public")));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`LeadRecovery API listening on http://localhost:${port}`);
  });
}
