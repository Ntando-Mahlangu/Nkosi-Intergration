import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./db/index.js";
import type { AppConfig, AppContext } from "./lib/context.js";
import { errorHandler, HttpError } from "./lib/http.js";
import { csrfGuard, requireAuth, sessionMiddleware } from "./lib/auth.js";
import { authRouter } from "./routes/auth.js";
import { coreRouter } from "./routes/core.js";
import { workspaceRouter } from "./routes/workspace.js";
import { tasksRouter } from "./routes/tasks.js";
import { meetingsRouter } from "./routes/meetings.js";
import { reportsRouter } from "./routes/reports.js";
import { projectsRouter } from "./routes/projects.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { searchRouter } from "./routes/search.js";
import { fakaweRouter } from "./routes/fakawe.js";
import { managementRouter } from "./routes/management.js";
import { opportunitiesRouter } from "./routes/opportunities.js";
import { learningRouter } from "./routes/learning.js";
import { adminRouter } from "./routes/admin.js";
import { notificationsRouter } from "./routes/notifications.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DEMO_PASSWORD = "CSI-demo-2026";
/** Where Vite serves the client during `npm run dev`. */
const DEV_CLIENT_URL = process.env.DEV_CLIENT_URL || "http://localhost:5173";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development") as AppConfig["env"];
  const publicUrl = env.PUBLIC_URL || `http://localhost:${env.PORT || 4000}`;
  return {
    env: nodeEnv,
    publicUrl,
    secureCookies: publicUrl.startsWith("https://"),
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    aiModel: env.AI_MODEL || "claude-opus-5-5",
    google: { clientId: env.GOOGLE_CLIENT_ID || "", clientSecret: env.GOOGLE_CLIENT_SECRET || "", allowedDomain: env.GOOGLE_ALLOWED_DOMAIN || "" },
    // Fixed, documented password for FICTIONAL demo accounts in development only. Never used in production.
    demoPassword: env.DEMO_PASSWORD || (nodeEnv === "production" ? "" : DEFAULT_DEMO_PASSWORD),
  };
}

export function createApp(db: Db, config: AppConfig) {
  const ctx: AppContext = { db, config };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.env === "production" ? 1 : false);

  // Security headers (CSP allows only same-origin scripts/styles; no inline scripts in the built client).
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self' https://accounts.google.com",
    );
    if (config.secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  app.use((req, _res, next) => {
    req.ctx = ctx;
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use(sessionMiddleware);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/auth", csrfGuard, authRouter);

  const api = express.Router();
  api.use(csrfGuard, requireAuth);
  api.use("/", coreRouter);
  api.use("/workspace", workspaceRouter);
  api.use("/tasks", tasksRouter);
  api.use("/meetings", meetingsRouter);
  api.use("/reports", reportsRouter);
  api.use("/", projectsRouter); // /projects, /programmes, /milestones, /deliverables, /risks, /decisions, /dependencies
  api.use("/knowledge", knowledgeRouter);
  api.use("/", searchRouter); // /search, /assistant
  api.use("/fakawe", fakaweRouter);
  api.use("/management", managementRouter);
  api.use("/", opportunitiesRouter); // /opportunities
  api.use("/", learningRouter); // /learning, /improvements
  api.use("/admin", adminRouter);
  api.use("/notifications", notificationsRouter);
  api.use((_req, _res, next) => next(new HttpError(404, "Unknown API endpoint.")));
  app.use("/api", api);

  // Static client (production build). In development Vite serves the client and proxies /api.
  const clientDir = [path.join(here, "../dist-client"), path.join(here, "../../dist-client")].find((d) => fs.existsSync(path.join(d, "index.html")));
  if (clientDir) {
    app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
  } else if (config.env !== "production") {
    // Development without a client build: the UI is served by Vite. Send browsers there instead of "Cannot GET /".
    app.get("*", (req, res) => res.redirect(DEV_CLIENT_URL + req.originalUrl));
  }

  app.use(errorHandler);
  return app;
}
