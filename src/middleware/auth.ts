import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { TenantStore } from "../store/types.js";
import type { Tenant } from "../types.js";
import { safeCompare } from "../security.js";

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
  return async (req: Request, res: Response, next: NextFunction) => {
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
  };
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
