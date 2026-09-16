import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { TenantStore } from "../store/types.js";
import type { Tenant } from "../types.js";
import { safeCompare } from "../security.js";
import { asyncHandler } from "./asyncHandler.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

/** Resolves the calling tenant from `Authorization: Bearer <tenant api key>` and attaches it to `req.tenant`. */
export function requireTenantAuth(tenantStore: TenantStore): RequestHandler {
  // asyncHandler-wrapped for the same reason every route handler using this
  // is: it's async middleware, not a route handler, but Express 4 doesn't
  // forward a rejection from either kind to error-handling middleware on
  // its own — without this, tenantStore.getTenantByApiKey throwing (a
  // transient DB error) would leave the request hanging forever with no
  // response ever sent, on every tenant-authenticated route in the app.
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "missing Authorization: Bearer <api key> header" });
      return;
    }
    const tenant = await tenantStore.getTenantByApiKey(token);
    if (!tenant) {
      res.status(401).json({ error: "invalid API key" });
      return;
    }
    if (tenant.status === "suspended") {
      res.status(403).json({ error: "this tenant has been suspended" });
      return;
    }
    req.tenant = tenant;
    next();
  });
}

/** Protects tenant-management endpoints with a single operator-held admin key (ADMIN_API_KEY env var). */
export function requireAdminAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
      res.status(503).json({ error: "admin API disabled: ADMIN_API_KEY is not set" });
      return;
    }
    const token = extractBearerToken(req);
    if (!token || !safeCompare(token, adminKey)) {
      res.status(401).json({ error: "invalid admin key" });
      return;
    }
    next();
  };
}
