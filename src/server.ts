import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { createStores } from "./store/index.js";
import { requireTenantAuth } from "./middleware/auth.js";
import { createTenantLimiter } from "./middleware/rateLimit.js";
import { createTenantRoutes } from "./routes/tenants.js";
import { createWebhookRoutes } from "./webhooks/index.js";
import { buildFollowUpPlans, buildRecoveryPlans, runRecoveryWorkflow } from "./workflow.js";

function parsePageParams(req: Request): { limit?: number; offset: number } {
  const limitRaw = Number(req.query.limit);
  const offsetRaw = Number(req.query.offset);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

function paginate<T>(items: T[], { limit, offset }: { limit?: number; offset: number }): T[] {
  if (limit === undefined && offset === 0) return items; // default: unchanged behavior, no params given
  return items.slice(offset, limit === undefined ? undefined : offset + limit);
}

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

  const auth = [createTenantLimiter(), requireTenantAuth(stores.tenantStore)];

  // Optional ?limit=&offset= pagination; omitted (the default) returns everything, unchanged from before —
  // existing dashboards that don't pass these params see no behavior change. X-Total-Count always reports the full count.
  app.get("/leads", ...auth, async (req: Request, res: Response) => {
    const leads = await stores.leadStore.getAllLeads(req.tenant!.id);
    res.set("X-Total-Count", String(leads.length));
    res.json(paginate(leads, parsePageParams(req)));
  });

  // Dry run: initial-outreach + follow-up plans, nothing sent or mutated.
  app.get("/leads/plan", ...auth, async (req: Request, res: Response) => {
    const leads = await stores.leadStore.getAllLeads(req.tenant!.id);
    const initial = buildRecoveryPlans(req.tenant!, leads);
    const followUps = buildFollowUpPlans(req.tenant!, leads);
    const plans = [...initial.plans, ...followUps.plans];
    res.set("X-Total-Count", String(plans.length));
    res.json({
      plans: paginate(plans, parsePageParams(req)),
      skipped: [...initial.skipped, ...followUps.skipped],
    });
  });

  app.get("/leads/:id/messages", ...auth, async (req: Request, res: Response) => {
    res.json(await stores.messageStore.getMessagesForLead(req.tenant!.id, req.params.id));
  });

  // Executes the full workflow: sends via channel adapters, updates lead status, logs messages.
  app.post("/workflow/run", ...auth, async (req: Request, res: Response) => {
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
