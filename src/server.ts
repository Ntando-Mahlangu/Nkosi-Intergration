import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { createStores } from "./store/index.js";
import { getPool } from "./db/pool.js";
import { requireTenantAuth } from "./middleware/auth.js";
import { createTenantLimiter } from "./middleware/rateLimit.js";
import { createTenantRoutes } from "./routes/tenants.js";
import { createWebhookRoutes } from "./webhooks/index.js";
import { buildFollowUpPlans, buildRecoveryPlans, runRecoveryWorkflow } from "./workflow.js";
import { parsePageParams, paginate } from "./pagination.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const stores = createStores();
  const app = express();
  app.use(createCorsMiddleware());

  // Structured request log, aggregator-friendly. Skips /health and /ready —
  // those get polled constantly by orchestrators/load balancers and would
  // otherwise drown out everything else.
  app.use((req: Request, res: Response, next) => {
    if (req.path === "/health" || req.path === "/ready") {
      next();
      return;
    }
    const start = Date.now();
    res.on("finish", () => {
      logger.info("http_request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  // Liveness: the process is up. Deliberately checks nothing external — an
  // orchestrator killing/restarting the container on a slow DB would only
  // make things worse. Always 200 as long as the event loop is responsive.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Readiness: safe to receive traffic. Checks DB connectivity when
  // configured, so an orchestrator can hold traffic back from an instance
  // that can't reach Postgres instead of routing requests it can't serve.
  app.get("/ready", async (_req: Request, res: Response) => {
    if (!process.env.DATABASE_URL) {
      res.json({ ok: true, database: "not configured" });
      return;
    }
    try {
      await getPool().query("SELECT 1");
      res.json({ ok: true, database: "ok" });
    } catch (err) {
      res.status(503).json({ ok: false, database: "unreachable", error: (err as Error).message });
    }
  });

  // Webhooks parse their own bodies (form-encoded/multipart) — mount before the global json() parser.
  app.use(createWebhookRoutes(stores));

  app.use(express.json());
  app.use(createTenantRoutes(stores));

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
    logger.info("server_listening", { port });
  });
}
