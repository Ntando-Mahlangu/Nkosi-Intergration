import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { createStores } from "./store/index.js";
import { getPool } from "./db/pool.js";
import { createTenantRoutes } from "./routes/tenants.js";
import { createTeamRoutes } from "./routes/team.js";
import { createLeadRoutes } from "./routes/leads.js";
import { createWorkflowRoutes } from "./routes/workflow.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createPublicCaptureRoutes } from "./routes/publicCapture.js";
import { createPublicChatRoutes } from "./routes/publicChat.js";
import { createWebhookRoutes } from "./webhooks/index.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { logger } from "./logger.js";
import { installFatalErrorHandlers } from "./fatalErrorHandlers.js";
import { CURRENT_TERMS_VERSION } from "./terms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = (
  JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")) as { version: string }
).version;

export function createApp() {
  const stores = createStores();
  const app = express();

  // Without this, req.ip (what every rate limiter in middleware/rateLimit.ts
  // keys on) is always the immediate socket peer, never the real client, no
  // matter what X-Forwarded-For says — so every distinct client behind one
  // reverse proxy shares a single rate-limit bucket, and one noisy tenant
  // (or attacker) can 429-lock out every other tenant on the same limiter.
  //
  // Deliberately gated on TRUST_PROXY_HOPS alone, NOT on PUBLIC_BASE_URL:
  // DEPLOYMENT.md says to set PUBLIC_BASE_URL "any time the app is reachable
  // from the public internet" — including a direct-exposure deployment, or
  // one behind a CDN/load balancer that passes X-Forwarded-For straight
  // through instead of overwriting it. Inferring "trust this header" from
  // that unrelated signal would let any client set their own
  // X-Forwarded-For and get a fresh rate-limit bucket on every request,
  // bypassing the abuse protection those limiters exist for. Only set
  // TRUST_PROXY_HOPS once you've verified your actual proxy topology
  // overwrites/appends this header itself and a client's own value can't
  // survive to this app.
  //
  // Validated rather than passed straight through: Express's `trust proxy`
  // silently treats a NaN hop count (e.g. from a typo'd env var) as "trust
  // nothing" — if the operator already opted in, warn and fall back to 1
  // hop instead of silently reverting to no protection at all. 0 is kept as
  // its own valid, distinct value (rather than folded into that same
  // fallback) since an operator may set it deliberately to mean "trust
  // proxy off" — e.g. after removing a reverse proxy — and silently
  // promoting that to 1 hop would enable X-Forwarded-For spoofing they
  // explicitly opted out of.
  if (process.env.TRUST_PROXY_HOPS !== undefined) {
    const rawHops = process.env.TRUST_PROXY_HOPS;
    const parsed = Number(rawHops);
    const hops = Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
    if (hops !== parsed) logger.warn("invalid_trust_proxy_hops", { value: rawHops, using: hops });
    app.set("trust proxy", hops);
  }

  app.use(createCorsMiddleware());

  // See "API versioning" in README.md: there's no /v1 path prefix (this API
  // has no external consumers yet to protect with one), but every response
  // names the exact version it came from, so a client can at least detect
  // what it's talking to.
  app.use((_req: Request, res: Response, next) => {
    res.setHeader("X-API-Version", packageVersion);
    next();
  });

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

  // Public (no auth) — lets every client-facing page fetch the exact
  // version string it must send back to POST /tenants/me/accept-terms,
  // rather than hardcoding it separately in each of the five static pages.
  app.get("/terms-version", (_req: Request, res: Response) => {
    res.json({ version: CURRENT_TERMS_VERSION });
  });

  // Readiness: safe to receive traffic. Checks DB connectivity when
  // configured, so an orchestrator can hold traffic back from an instance
  // that can't reach Postgres instead of routing requests it can't serve.
  app.get(
    "/ready",
    asyncHandler(async (_req: Request, res: Response) => {
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
    })
  );

  // Webhooks parse their own bodies (form-encoded/multipart) — mount before the global json() parser.
  app.use(createWebhookRoutes(stores));

  app.use(express.json());
  app.use(createAuthRoutes(stores));
  app.use(createPublicCaptureRoutes(stores));
  app.use(createPublicChatRoutes(stores));
  app.use(createTenantRoutes(stores));
  app.use(createTeamRoutes(stores));
  app.use(createLeadRoutes(stores));
  app.use(createWorkflowRoutes(stores));

  app.use(express.static(path.join(__dirname, "..", "public")));

  // Last-resort safety net: catches anything asyncHandler forwarded via
  // next(err) (a channel adapter throwing, a store query failing, ...) and
  // responds with 500 instead of letting it become an unhandled rejection —
  // which, with installFatalErrorHandlers wired up at the real entrypoint
  // below, would otherwise kill the whole process over a single request.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("unhandled_route_error", { error: (err as Error).message, stack: (err as Error).stack });
    if (res.headersSent) return;
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installFatalErrorHandlers("server");
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();
  app.listen(port, () => {
    logger.info("server_listening", { port });
  });
}
