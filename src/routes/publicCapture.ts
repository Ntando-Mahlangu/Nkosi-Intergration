import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import type { Lead } from "../types.js";
import { safeCompare } from "../security.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createPublicFormLimiter } from "../middleware/rateLimit.js";
import { generateId } from "../idgen.js";

const MAX_FIELD_LENGTH = 2000;

function isValidField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/**
 * A public, unauthenticated lead-capture endpoint meant to be called
 * directly from a tenant's own website (a contact/quote-request form —
 * see public/settings.html's "Capture leads from your website" panel for
 * the embeddable snippet a client copies onto their site). Deliberately not
 * behind requireTenantAuth: a real API key in front-end JS on a public page
 * would let anyone who views source read/send on that tenant's behalf.
 * `formKey` (Tenant.publicFormKey) is the opposite of that — a token that
 * can only ever create a lead through this one endpoint, so exposing it
 * client-side carries none of the API key's risk. See src/idgen.ts's
 * generateFormKey doc comment.
 */
export function createPublicCaptureRoutes({ tenantStore, leadStore }: Stores): Router {
  const router = Router();

  // A hand-rolled, narrowly-scoped CORS allowance — deliberately separate
  // from middleware/cors.ts's LEADRECOVERY_CORS_ORIGIN (which is an
  // operator-controlled allowlist for a *replacement* frontend, and would
  // let an allowed origin call every tenant-authenticated route, not just
  // this one). This endpoint is meant to be called from an arbitrary
  // client website whose domain LeadRecovery has no way to know in
  // advance, so it always allows any origin — safe specifically because
  // formKey scopes a caller to nothing but creating a lead, unlike a
  // leaked API key.
  router.use("/public/leads/:tenantId", (req: Request, res: Response, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  });

  router.post(
    "/public/leads/:tenantId",
    createPublicFormLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = await tenantStore.getTenant(req.params.tenantId);
      // Same generic "invalid" response whether the tenant doesn't exist or
      // the formKey is wrong — distinguishing the two would let a caller
      // enumerate valid tenant ids by trying random ones.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const formKey = body.formKey;
      if (
        !tenant ||
        !tenant.publicFormKey ||
        typeof formKey !== "string" ||
        !safeCompare(formKey, tenant.publicFormKey)
      ) {
        res.status(401).json({ error: "invalid tenantId or formKey" });
        return;
      }
      if (tenant.status === "suspended") {
        res.status(403).json({ error: "this tenant is not currently accepting new leads" });
        return;
      }

      const name = isValidField(body.name) ? body.name.trim() : undefined;
      const phone = isValidField(body.phone) ? body.phone.trim() : undefined;
      const email = isValidField(body.email) ? body.email.trim() : undefined;
      const requestedService = isValidField(body.requestedService) ? body.requestedService.trim() : undefined;
      const notes = isValidField(body.notes) ? body.notes.trim() : undefined;
      if (!phone && !email) {
        res.status(400).json({ error: "phone or email is required" });
        return;
      }

      const lead: Lead = {
        id: generateId("lead"),
        tenantId: tenant.id,
        name,
        phone,
        email,
        source: "website_form",
        createdAt: new Date().toISOString(),
        requestedService,
        notes,
        status: "new",
      };
      await leadStore.createLead(lead);
      res.status(201).json({ ok: true });
    })
  );

  return router;
}
