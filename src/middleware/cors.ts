import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Opt-in CORS support for calling the API from a separate frontend origin
 * (the bundled dashboards are served same-origin and need none of this).
 * Controlled entirely by LEADRECOVERY_CORS_ORIGIN — unset means no CORS
 * headers at all (today's behavior, unchanged). Auth here is a Bearer
 * token, never cookies, so this never needs Access-Control-Allow-Credentials.
 */
export function createCorsMiddleware(): RequestHandler {
  const configured = process.env.LEADRECOVERY_CORS_ORIGIN;
  const allowAll = configured === "*";
  const allowedOrigins = new Set(
    (configured ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );

  return (req: Request, res: Response, next: NextFunction) => {
    if (!configured) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (origin && (allowAll || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      // Per the Fetch/CORS spec, a cross-origin response only exposes the
      // safelisted headers to JS unless listed here — X-Total-Count (set by
      // every paginated list endpoint: /leads, /leads/plan, /admin/tenants,
      // /admin/audit-log) needs this or a cross-origin caller (this exists
      // specifically to support one — see the doc comment above) always
      // reads it back as null, e.g. admin.html's pager treating a real
      // tenant count as 0.
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  };
}
